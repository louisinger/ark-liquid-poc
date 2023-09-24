import test from 'ava';
import { ECPairFactory } from 'ecpair';
import {
  address,
  ElementsValue,
  Extractor,
  Finalizer,
  networks,
  payments,
  Pset,
  Transaction,
} from 'liquidjs-lib';
import * as ecc from 'tiny-secp256k1';

import { broadcast, faucet, fetchTx, signTransaction } from './_regtest.spec';
import {
  ASP_FEE,
  createPoolTransaction,
  makeForfeitTransaction,
  makeSendMessage,
  OnboardOrder,
  SendOrder,
  signSendOrderPoolPset,
  validateSendOrder,
} from './ark';

const ECPair = ECPairFactory(ecc);

const alice = ECPair.makeRandom();
const aliceP2WPKH = payments.p2wpkh({
  pubkey: alice.publicKey,
  network: networks.regtest,
});

const serviceProvider = ECPair.makeRandom();
const serviceProviderP2WPKH = payments.p2wpkh({
  pubkey: serviceProvider.publicKey,
  network: networks.regtest,
});

const bob = ECPair.makeRandom();
const bobP2WPKH = payments.p2wpkh({
  pubkey: bob.publicKey,
  network: networks.regtest,
});

let aliceUtxo: Transaction['outs'][0];
let aliceUtxoOutpoint: { txid: string; vout: number };
// faucet Alice
test.before(async (t) => {
  const { txid, vout } = await faucet(aliceP2WPKH.address);
  const txHex = await fetchTx(txid);
  const transaction = Transaction.fromHex(txHex);
  aliceUtxo = transaction.outs[vout];
  aliceUtxoOutpoint = { txid, vout };
  t.pass();
});

test('ark POC', async (t) => {
  // Alice onboards on ark, it creates an onboard order with her utxo and send it to the ark service provider
  const onboardOrder: OnboardOrder = {
    coins: [
      {
        txid: aliceUtxoOutpoint.txid,
        txIndex: aliceUtxoOutpoint.vout,
        witnessUtxo: aliceUtxo,
        sighashType: Transaction.SIGHASH_ALL,
      },
    ],
    redeemPublicKey: alice.publicKey,
  };

  // the ASP receives several onboard orders and creates a pool transaction
  // it also creates the assosiated redeem txs and signs them
  const { redeems, unsignedPoolPset } = createPoolTransaction(
    serviceProviderP2WPKH.address,
    serviceProvider.privateKey,
    {
      onboardOrders: [onboardOrder],
      sendOrders: [],
    },
    networks.regtest.genesisBlockHash,
    networks.regtest.assetHash
  );

  // the ASP sends the pool transaction and the redeem tx to Alice
  // Alice checks that redeem is signed by the ASP
  // Alice checks that pool tx creates a valid virtual utxo

  // Alice signs the pool tx and resend it to ASP
  const signedPoolPset = signTransaction(
    Pset.fromBase64(unsignedPoolPset),
    [[alice]],
    Transaction.SIGHASH_ALL,
    ecc
  );

  // ASP checks that the pool tx is signed by Alice
  // ASP finalize the pool tx and broadcast it

  const finalizer = new Finalizer(signedPoolPset);
  finalizer.finalize();
  const poolTransaction = Extractor.extract(signedPoolPset);
  const txID = await broadcast(poolTransaction.toHex());
  // Once broadcasted, Alice has 1 virtual L-BTC on Ark
  const aliceVirtualUtxo = poolTransaction.outs[0];
  // At any moment, Alice can exit the Ark by signing and broadcasting the redeem tx
  const aliceRedeemPset = Pset.fromBase64(
    redeems.get(alice.publicKey.toString('hex'))
  );
  console.log(
    'Alice redeem pset: ',
    redeems.get(alice.publicKey.toString('hex'))
  );

  // then Alice wants to send it to Bob
  // she creates a special message containing the utxo amount + the bob script (TODO include change??)
  const sendMessage = makeSendMessage(
    txID,
    0,
    address.toOutputScript(bobP2WPKH.address).toString('hex'),
    ElementsValue.fromBytes(aliceVirtualUtxo.value).number - ASP_FEE
  );

  console.log('sendMessage (Alice -> Bob)', sendMessage.toString('hex'));

  // she signs the message with her private key
  const aliceSignature = ecc.signSchnorr(
    sendMessage,
    alice.privateKey,
    Buffer.alloc(32)
  );

  const sendOrder: Omit<SendOrder, 'forfeitTx'> = {
    address: bobP2WPKH.address,
    amount: ElementsValue.fromBytes(aliceVirtualUtxo.value).number - ASP_FEE,
    coin: {
      txid: txID,
      txIndex: 0,
      witnessUtxo: aliceVirtualUtxo,
      sighashType: Transaction.SIGHASH_DEFAULT,
    },
    signature: Buffer.from(aliceSignature).toString('hex'),
  };

  // she creates a forfeit tx using the redeem tx she gets during the onboarding
  const forfeitTx = makeForfeitTransaction(
    sendOrder,
    aliceRedeemPset,
    alice.privateKey,
    address.toOutputScript(serviceProviderP2WPKH.address),
    networks.regtest.genesisBlockHash
  );

  // she sends all to ASP
  const finalSendOrder = {
    ...sendOrder,
    forfeitTx,
  };

  // ASP checks that the forfeit tx is valid
  const [valid, reason] = validateSendOrder(
    finalSendOrder,
    aliceRedeemPset,
    address.toOutputScript(serviceProviderP2WPKH.address).toString('hex'),
    networks.regtest.genesisBlockHash
  );

  t.true(valid, reason);

  // Once ASP has validated the sendOrder, bob can consider the utxo is received
  // even if it is not broadcasted yet, ASP has now an incentive to broadcast it (get the fees)

  // ASP craft the next pool Tx and includes the bob payout
  const { unsignedPoolPset: nextPoolTx } = createPoolTransaction(
    serviceProviderP2WPKH.address,
    serviceProvider.privateKey,
    {
      onboardOrders: [],
      sendOrders: [finalSendOrder],
    },
    networks.regtest.genesisBlockHash,
    networks.regtest.assetHash
  );

  // this time, ASP has to sign the tx too because it contains send orders
  const signedNextPoolPset = signSendOrderPoolPset(
    Pset.fromBase64(nextPoolTx),
    finalSendOrder,
    serviceProvider.privateKey,
    alice.publicKey
  );

  // ASP broadcast the pool tx
  const nextPoolTransaction = Extractor.extract(signedNextPoolPset);

  const nextTxID = await broadcast(nextPoolTransaction.toHex());
  console.log('next pool tx:', nextTxID);

  // once the nextTx is confirmed, Bob owns the coin on-chain

  t.pass();
});
