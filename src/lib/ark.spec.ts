import test from 'ava';
import { ECPairFactory } from 'ecpair';
import { Extractor, Finalizer, networks, Pset } from 'liquidjs-lib';
import * as ecc from 'tiny-secp256k1';

import { broadcast, TestWallet } from './_regtest.spec';
import { createPoolTransaction, hashForfeitMessage } from './ark';
import { ForfeitMessage, OnboardOrder, TransferOrder } from './core';

const ECPair = ECPairFactory(ecc);

const ONE_LBTC = 1_0000_0000;
const LBTC = networks.regtest.assetHash;

const alice = ECPair.makeRandom();
const aliceWallet = new TestWallet(alice);

const serviceProvider = ECPair.makeRandom();
const serviceProviderWallet = new TestWallet(serviceProvider);

const bob = ECPair.makeRandom();

test('it should let Alice to create vUtxo, and send it to Bob', async (t) => {
  const { coins, change } = await aliceWallet.coinSelect(ONE_LBTC, LBTC);
  t.is(change, undefined, 'alice change should be undefined');

  // Alice selects some on-chain coin to onboard on Ark
  const aliceOnboard: OnboardOrder = {
    coins,
    vUtxoPublicKey: alice.publicKey,
  };

  // the ASP receives several onboard orders and creates a pool transaction
  // it returns associated taproot vUtxo taproot tree to Alice
  const { vUtxos, unsignedPoolPset } = await createPoolTransaction(
    serviceProviderWallet,
    [aliceOnboard],
    [],
    networks.regtest
  );

  const vUtxoAlice = vUtxos.get(alice.publicKey.toString('hex'));
  t.not(vUtxoAlice, undefined, 'createPoolTransaction should return vUtxos');

  // the ASP sends the pool transaction and the redeem tx to Alice
  // Alice checks that the tree is correct and associated with its publickey

  // Alice signs the pool tx and resend it to ASP
  const signedPoolPsetByAlice = aliceWallet.sign(
    Pset.fromBase64(unsignedPoolPset)
  );
  const signedPoolPset = serviceProviderWallet.sign(signedPoolPsetByAlice);

  // ASP checks that the pool tx is signed by Alice
  // ASP finalize the pool tx and broadcast it
  new Finalizer(signedPoolPset).finalize();
  const poolTransaction = Extractor.extract(signedPoolPset);
  const txID = await broadcast(poolTransaction.toHex());
  console.log('pool txID 0:', txID);
  console.log('pool tx 0 (hex):', poolTransaction.toHex());
  console.log('\n');

  // At any moment, Alice can exit the Ark by creating a redeem transaction
  // const aliceRedeem = makeRedeemTransaction(vUtxoAlice.vUtxo, vUtxoAlice.vUtxoTree.redeemLeaf)

  // then Alice wants to send the vUtxo to Bob
  // firstly, she ask for a place in next pool transaction to the ASP
  const aliceTransferOrder: TransferOrder = {
    toPublicKey: bob.publicKey,
    vUtxo: vUtxoAlice.vUtxo,
  };

  // the ASP gets the transfer order and process it in the next pool tx
  const nextPoolTx = await createPoolTransaction(
    serviceProviderWallet,
    [],
    [aliceTransferOrder],
    networks.regtest
  );

  // Alice checks the next Pool tx, if it looks OK, then she creates a *ForfeitMessage* and hash it
  // the message includes a "promised txID", making the signature valid if and only if the tx exists on chain.
  const aliceForfeitMessage: ForfeitMessage = {
    promisedPoolTxID: Pset.fromBase64(nextPoolTx.unsignedPoolPset)
      .unsignedTx()
      .getId(),
    vUtxoIndex: vUtxoAlice.vUtxo.txIndex,
    vUtxoTxID: vUtxoAlice.vUtxo.txid,
  };

  const aliceForfeitMessageHash = hashForfeitMessage(aliceForfeitMessage);

  // she signs the message with the vUtxo private key
  const aliceSignature = ecc.signSchnorr(
    aliceForfeitMessageHash,
    alice.privateKey,
    Buffer.alloc(32)
  );
  t.is(aliceSignature.length, 64);

  // she sends back the signature to the ASP.
  // if valid for ASP, it signs the next pool tx. Alice doesn't have to sign anything more.
  // if everything goes well, Alice won't broadcast a redeem tx and the ASP will get the vUtxo control in 1 month.
  // if Alice broadcasts a redeem tx (hardcoded scriptPubKey), ASP has the forfeit message and can use it to get the vUtxo.
  // As soon as Alice as sent the signature, she lost the control on vUtxo IF the next pool tx ID (including bob vUtxo) is broadcasted.
  const nextPoolTxSigned = serviceProviderWallet.sign(
    Pset.fromBase64(nextPoolTx.unsignedPoolPset)
  );

  new Finalizer(nextPoolTxSigned).finalize();

  const nextPoolTransaction = Extractor.extract(nextPoolTxSigned);

  const nextTxID = await broadcast(nextPoolTransaction.toHex());
  console.log('pool txID 1:', nextTxID);
  console.log('pool tx 0 (hex):', nextPoolTransaction.toHex());

  // once the nextTx is in the mempool, Bob owns the vUtxo and can repeat the process.
  t.pass();
});
