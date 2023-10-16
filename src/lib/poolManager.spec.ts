import test from 'ava';
import ECPairFactory from 'ecpair';
import {
  Extractor,
  Finalizer,
  networks,
  Pset,
  Transaction,
  Updater,
} from 'liquidjs-lib';
import * as ecc from 'tiny-secp256k1';

import { broadcast, TestRepository, TestWallet } from './_regtest.spec';
import {
  createLiftTransaction,
  hashForfeitMessage,
  makeRedeemTransaction,
} from './ark';
import { WsElectrumChainSource } from './chainsource';
import { LiftArgs } from './core';
import { PoolManagerFactory } from './poolManager';
import { PoolWatcherFactory } from './poolWatcher';

const ECPair = ECPairFactory(ecc);

const ONE_LBTC = 1_0000_0000;
const LBTC = networks.regtest.assetHash;

const alice = ECPair.makeRandom();
const aliceWallet = new TestWallet(alice);

const serviceProvider = ECPair.makeRandom();
const serviceProviderWallet = new TestWallet(serviceProvider);

const bob = ECPair.makeRandom();

test('PoolManager should handle pool transactions signatures & PoolWatcher should broadcast forfeit tx', async (t) => {
  const repository = new TestRepository();
  const chainSource = new WsElectrumChainSource('ws://localhost:1234');
  const watcher = PoolWatcherFactory(
    serviceProviderWallet,
    repository,
    chainSource,
    networks.regtest
  );
  const manager = PoolManagerFactory(
    serviceProviderWallet,
    repository,
    networks.regtest
  );

  const { coins, change } = await aliceWallet.coinSelect(ONE_LBTC, LBTC);
  t.is(change, undefined, 'alice change should be undefined');

  const aliceOnboard: LiftArgs = {
    coins,
    vUtxoPublicKey: alice.publicKey,
  };

  const { vUtxo, leaves, unsignedPoolPset } = createLiftTransaction(
    serviceProviderWallet.getPublicKey(),
    [aliceOnboard],
    networks.regtest
  );

  const vUtxoAlice = leaves.get(alice.publicKey.subarray(1).toString('hex'));
  t.not(vUtxoAlice, undefined, 'createPoolTransaction should return vUtxos');
  const signedLiftPset = aliceWallet.sign(Pset.fromBase64(unsignedPoolPset));
  new Finalizer(signedLiftPset).finalize();
  const liftTransaction = Extractor.extract(signedLiftPset);
  await chainSource.broadcastTransaction(liftTransaction.toHex());
  console.log('lift transaction', liftTransaction.getId());

  const { forfeitMessage, changeUtxo } = await manager.sendRequest(
    { vUtxo, ...vUtxoAlice },
    bob.publicKey,
    10_000
  );
  t.not(changeUtxo, undefined, 'manager should return changeUtxo');

  const signedForfeit = aliceWallet.signSchnorr(
    hashForfeitMessage(forfeitMessage)
  );
  const txHex = await manager.send(
    forfeitMessage,
    signedForfeit.toString('hex')
  );
  await chainSource.broadcastTransaction(txHex);

  console.log('pool tx: ', txHex);
  console.log('pool txID: ', Transaction.fromHex(txHex).getId());

  // alice can still redeem the initial lifted vUTXO in order to "scam" the ASP
  const [aliceRedeem, finalizeRedeemInput] = makeRedeemTransaction(
    vUtxo,
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

  aliceWallet.addOutpointToSignWithKey(vUtxo.txid, vUtxo.txIndex);
  const signedRedeem = aliceWallet.sign(updater.pset);

  new Finalizer(signedRedeem).finalizeInput(0, finalizeRedeemInput).finalize();
  const redeemTransaction = Extractor.extract(signedRedeem);
  const redeemTxID = await broadcast(redeemTransaction.toHex());
  console.log('alice redeem', redeemTxID);

  // the watcher should detect alice redeem and use the forfeit tx to claim the vUTXO
  const broadcasted = await watcher.watchRedeem(
    alice.publicKey.toString('hex')
  );
  t.is(broadcasted.length, 1, 'watcher should broadcast a tx');

  const [{ hex }] = await chainSource.fetchTransactions([broadcasted[0]]);
  const forfeitTx = Transaction.fromHex(hex);

  t.is(
    forfeitTx.ins.at(0).hash.reverse().toString('hex'),
    forfeitMessage.promisedPoolTxID
  ); // first input is the connector
  t.is(forfeitTx.ins.at(1).hash.reverse().toString('hex'), redeemTxID); // spend the alice redeem output
  t.is(forfeitTx.ins.at(1).index, 0);
});
