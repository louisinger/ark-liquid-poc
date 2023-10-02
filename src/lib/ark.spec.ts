import test from 'ava';
import bip68 from 'bip68';
import { ECPairFactory } from 'ecpair';
import {
  Creator,
  CreatorOutput,
  ElementsValue,
  Extractor,
  Finalizer,
  networks,
  Pset,
  Transaction,
  Updater,
} from 'liquidjs-lib';
import * as ecc from 'tiny-secp256k1';

import { broadcast, TestWallet } from './_regtest.spec';
import {
  createPoolTransaction,
  forfeitFinalizer,
  hashForfeitMessage,
  makeRedeemTransaction,
} from './ark';
import { ForfeitMessage, OnboardOrder, TransferOrder } from './core';

const ECPair = ECPairFactory(ecc);

const ONE_LBTC = 1_0000_0000;
const LBTC = networks.regtest.assetHash;

const alice = ECPair.makeRandom();
const aliceWallet = new TestWallet(alice);

const serviceProvider = ECPair.makeRandom();
const serviceProviderWallet = new TestWallet(serviceProvider);

const bob = ECPair.makeRandom();

test('vUtxo can be sent as quick as the ASP creates a pool transaction', async (t) => {
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

test('vUtxo can leave the Ark using a redeem transaction', async (t) => {
  const { coins, change } = await aliceWallet.coinSelect(ONE_LBTC, LBTC);
  t.is(change, undefined, 'alice change should be undefined');

  const aliceOnboard: OnboardOrder = {
    coins,
    vUtxoPublicKey: alice.publicKey,
  };

  const { vUtxos, unsignedPoolPset } = await createPoolTransaction(
    serviceProviderWallet,
    [aliceOnboard],
    [],
    networks.regtest,
    undefined,
    bip68.encode({ blocks: 1 })
  );

  const vUtxoAlice = vUtxos.get(alice.publicKey.toString('hex'));
  t.not(vUtxoAlice, undefined, 'createPoolTransaction should return vUtxos');
  const signedPoolPsetByAlice = aliceWallet.sign(
    Pset.fromBase64(unsignedPoolPset)
  );
  const signedPoolPset = serviceProviderWallet.sign(signedPoolPsetByAlice);

  new Finalizer(signedPoolPset).finalize();
  const poolTransaction = Extractor.extract(signedPoolPset);
  await broadcast(poolTransaction.toHex());

  // At any moment, Alice can exit the Ark by creating a redeem transaction using the redeemLeaf she owns
  // The transaction will move the vUtxo coins to the redeem taproot tree, letting either Alice to claim it after x time or the ASP to claim it with the signed forfeit message
  const aliceRedeem = makeRedeemTransaction(
    vUtxoAlice.vUtxo,
    vUtxoAlice.vUtxoTree.redeemLeaf
  );

  const selectionForFees = await aliceWallet.coinSelect(500, LBTC);
  const updater = new Updater(aliceRedeem);
  updater.addInputs(selectionForFees.coins);
  updater.addOutputs([
    selectionForFees.change,
    {
      asset: LBTC,
      amount: 500,
    },
  ]);

  aliceWallet.addOutpointToSignWithKey(
    vUtxoAlice.vUtxo.txid,
    vUtxoAlice.vUtxo.txIndex
  );
  const signedRedeem = aliceWallet.sign(updater.pset);

  new Finalizer(signedRedeem).finalize();
  const redeemTransaction = Extractor.extract(signedRedeem);
  console.log('redeem tx (hex):', redeemTransaction.toHex());
  const redeemTxID = await broadcast(redeemTransaction.toHex());
  console.log('redeem txID:', redeemTxID);

  // after timeout (here 1 block), Alice can unlock the redeem tx output #0 (using vUtxo private key)
  await aliceWallet.coinSelect(500, LBTC); // will generate a block, for testing purpose only

  const moveRedeemUtxoPset = Creator.newPset({
    outputs: [
      new CreatorOutput(
        LBTC,
        ElementsValue.fromBytes(vUtxoAlice.vUtxo.witnessUtxo.value).number -
          500,
        aliceWallet.getAddressOutputScript()
      ),
      new CreatorOutput(LBTC, 500),
    ],
  });

  new Updater(moveRedeemUtxoPset).addInputs([
    {
      txid: redeemTransaction.getId(),
      txIndex: 0,
      witnessUtxo: redeemTransaction.outs[0],
      sighashType: Transaction.SIGHASH_DEFAULT,
      tapInternalKey: vUtxoAlice.vUtxo.tapInternalKey,
      tapLeafScript: vUtxoAlice.redeemTree.claimLeaf,
    },
  ]);

  aliceWallet.addOutpointToSignWithKey(redeemTransaction.getId(), 0);
  const signedMoveRedeemUtxoPset = aliceWallet.sign(moveRedeemUtxoPset);
  new Finalizer(signedMoveRedeemUtxoPset).finalize();
  const moveRedeemUtxoTx = Extractor.extract(signedMoveRedeemUtxoPset);
  console.log('move redeem tx (hex):', moveRedeemUtxoTx.toHex());
  const moveRedeemUtxoTxID = await broadcast(moveRedeemUtxoTx.toHex());
  console.log('move redeem txID:', moveRedeemUtxoTxID);
  t.pass();
});

test('ASP should be able to claim the sent vUtxo using a forfeit transaction', async (t) => {
  const { coins, change } = await aliceWallet.coinSelect(ONE_LBTC, LBTC);
  t.is(change, undefined, 'alice change should be undefined');

  const aliceOnboard: OnboardOrder = {
    coins,
    vUtxoPublicKey: alice.publicKey,
  };

  const { vUtxos, unsignedPoolPset } = await createPoolTransaction(
    serviceProviderWallet,
    [aliceOnboard],
    [],
    networks.regtest
  );

  const vUtxoAlice = vUtxos.get(alice.publicKey.toString('hex'));
  t.not(vUtxoAlice, undefined, 'createPoolTransaction should return vUtxos');

  const signedPoolPsetByAlice = aliceWallet.sign(
    Pset.fromBase64(unsignedPoolPset)
  );
  const signedPoolPset = serviceProviderWallet.sign(signedPoolPsetByAlice);

  new Finalizer(signedPoolPset).finalize();
  const poolTransaction = Extractor.extract(signedPoolPset);
  const txID = await broadcast(poolTransaction.toHex());
  console.log('pool txID 0:', txID);

  // At any moment, Alice can exit the Ark by creating a redeem transaction
  // const aliceRedeem = makeRedeemTransaction(vUtxoAlice.vUtxo, vUtxoAlice.vUtxoTree.redeemLeaf)

  const aliceTransferOrder: TransferOrder = {
    toPublicKey: bob.publicKey,
    vUtxo: vUtxoAlice.vUtxo,
  };

  const nextPoolTx = await createPoolTransaction(
    serviceProviderWallet,
    [],
    [aliceTransferOrder],
    networks.regtest
  );

  const aliceForfeitMessage: ForfeitMessage = {
    promisedPoolTxID: Pset.fromBase64(nextPoolTx.unsignedPoolPset)
      .unsignedTx()
      .getId(),
    vUtxoIndex: vUtxoAlice.vUtxo.txIndex,
    vUtxoTxID: vUtxoAlice.vUtxo.txid,
  };

  const aliceForfeitMessageHash = hashForfeitMessage(aliceForfeitMessage);

  const aliceSignature = Buffer.from(
    ecc.signSchnorr(aliceForfeitMessageHash, alice.privateKey, Buffer.alloc(32))
  );

  const nextPoolTxSigned = serviceProviderWallet.sign(
    Pset.fromBase64(nextPoolTx.unsignedPoolPset)
  );

  new Finalizer(nextPoolTxSigned).finalize();

  const nextPoolTransaction = Extractor.extract(nextPoolTxSigned);

  const nextTxID = await broadcast(nextPoolTransaction.toHex());
  console.log('pool txID 1:', nextTxID);

  // once the nextTx is in the mempool, Bob owns the vUtxo and can repeat the process.

  // However alice can still broadcast a redeem transaction:
  const aliceRedeem = makeRedeemTransaction(
    vUtxoAlice.vUtxo,
    vUtxoAlice.vUtxoTree.redeemLeaf
  );

  const selectionForFees = await aliceWallet.coinSelect(500, LBTC);
  const updater = new Updater(aliceRedeem);
  updater.addInputs(selectionForFees.coins);
  updater.addOutputs([
    selectionForFees.change,
    {
      asset: LBTC,
      amount: 500,
    },
  ]);

  aliceWallet.addOutpointToSignWithKey(
    vUtxoAlice.vUtxo.txid,
    vUtxoAlice.vUtxo.txIndex
  );
  const signedRedeem = aliceWallet.sign(updater.pset);

  new Finalizer(signedRedeem).finalize();
  const redeemTransaction = Extractor.extract(signedRedeem);
  console.log('redeem tx (hex):', redeemTransaction.toHex());
  const redeemTxID = await broadcast(redeemTransaction.toHex());
  console.log('redeem txID:', redeemTxID);

  // in that case, Alice has to wait for the timeout to move the coins.
  // However, the ASP can claim the coins using the forfeit message signature sent previously by Alice

  // the ASP must provide a connector input from the promised pool tx (here nextPoolTx)
  const connector = nextPoolTransaction.outs[nextPoolTx.connectors.at(0)];
  serviceProviderWallet.addOutpointToSignWithKey(
    nextPoolTransaction.getId(),
    nextPoolTx.connectors.at(0)
  );
  t.not(connector, undefined, 'nextPoolTx should have a connector');
  const connectorAmount = ElementsValue.fromBytes(connector.value).number;

  // the ASP creates a "forfeitTransaction"
  const forfeitPset = Creator.newPset({
    outputs: [
      new CreatorOutput(
        LBTC,
        connectorAmount +
          ElementsValue.fromBytes(vUtxoAlice.vUtxo.witnessUtxo.value).number -
          500,
        serviceProviderWallet.getAddressOutputScript()
      ),
      new CreatorOutput(LBTC, 500),
    ],
  });

  const forfeitUpdater = new Updater(forfeitPset);
  // connector MUST be input #0
  forfeitUpdater.addInputs([
    {
      txid: nextPoolTransaction.getId(),
      txIndex: nextPoolTx.connectors.at(0),
      witnessUtxo: connector,
      sighashType: Transaction.SIGHASH_ALL,
    },
    {
      txid: redeemTransaction.getId(),
      txIndex: 0,
      witnessUtxo: redeemTransaction.outs[0],
      sighashType: Transaction.SIGHASH_DEFAULT,
      tapInternalKey: vUtxoAlice.vUtxo.tapInternalKey,
      tapLeafScript: vUtxoAlice.redeemTree.forfeitLeaf,
    },
  ]);

  // ASP signs the forfeit message
  const providerSignature = Buffer.from(
    ecc.signSchnorr(
      aliceForfeitMessageHash,
      serviceProvider.privateKey,
      Buffer.alloc(32)
    )
  );

  const signedForfeitPset = serviceProviderWallet.sign(forfeitUpdater.pset);

  new Finalizer(signedForfeitPset)
    .finalizeInput(0)
    .finalizeInput(
      1,
      forfeitFinalizer(providerSignature, aliceSignature, aliceForfeitMessage)
    );

  const signedForfeitTx = Extractor.extract(forfeitUpdater.pset);
  console.log('forfeit tx (hex):', signedForfeitTx.toHex());
  const forfeitTxID = await broadcast(signedForfeitTx.toHex());
  console.log('forfeit txID:', forfeitTxID);

  // ASP has now the coins, Alice can't claim them anymore

  t.pass();
});
