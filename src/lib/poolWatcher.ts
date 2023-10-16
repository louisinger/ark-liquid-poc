import {
  Creator,
  CreatorOutput,
  ElementsValue,
  Extractor,
  Finalizer,
  networks,
  Transaction,
  Updater,
} from 'liquidjs-lib';

import { hashForfeitMessage, redeemPath } from './ark';
import { ForfeitMessage, Wallet } from './core';
import { ForfeitScript } from './script';

export interface PoolWatcher {
  // watch for an illegal redeem transaction (w/ a forfeited signature)
  watchRedeem(vUtxoPublicKey: string): Promise<string[]>;
  // watch for any claim available for a pool transaction
  watchClaim(poolTxID: string): Promise<string[]>;
}

export interface PoolWatcherRepository {
  getForfeit(
    scriptPubKey: string
  ): Promise<{ msg: ForfeitMessage; sig: string }>;
  getPoolTransaction(txID: string): Promise<{
    hex: string;
    connectors: number[];
  }>;
  updateConnectors(poolID: string, connectors: number[]): Promise<void>;
}

export type TransactionHistory = Array<{
  tx_hash: string;
  height: number;
}>;

export type Unspent = {
  height: number;
  tx_pos: number;
  tx_hash: string;
};

export interface ChainSource {
  listUnspents(script: string): Promise<Unspent[]>;
  fetchTransactions(txids: string[]): Promise<{ txID: string; hex: string }[]>;
  broadcastTransaction(hex: string): Promise<string>;
  close(): Promise<void>;
}

export function PoolWatcherFactory(
  wallet: Wallet,
  repository: PoolWatcherRepository,
  chain: ChainSource,
  network: networks.Network
): PoolWatcher {
  return new _PoolWatcher(wallet, repository, chain, network);
}

class _PoolWatcher implements PoolWatcher {
  constructor(
    private wallet: Wallet,
    private repository: PoolWatcherRepository,
    private chain: ChainSource,
    private network: networks.Network
  ) {}

  async watchRedeem(vUtxoPublicKey: string): Promise<string[]> {
    const aspPublicKey = this.wallet.getPublicKey().subarray(1);
    const { outputScript, redeemTree } = redeemPath(
      aspPublicKey,
      Buffer.from(vUtxoPublicKey, 'hex').subarray(1)
    );
    const redeemScriptPubKey = outputScript.toString('hex');

    const forfeit = await this.repository.getForfeit(redeemScriptPubKey);
    const sig = this.wallet.signSchnorr(hashForfeitMessage(forfeit.msg));
    const unspents = await this.chain.listUnspents(redeemScriptPubKey);

    const txs = await this.chain.fetchTransactions(
      unspents.map((u) => u.tx_hash)
    );

    const broadcastedTxIDs: string[] = [];

    for (const [index, { tx_pos }] of unspents.entries()) {
      const tx = Transaction.fromHex(txs[index].hex);
      const redeemOutput = tx.outs[tx_pos];

      const promisedPool = await this.repository.getPoolTransaction(
        forfeit.msg.promisedPoolTxID
      );
      if (promisedPool.connectors.length === 0)
        throw new Error(
          'unable to forfeit, no more connector in promised pool tx'
        );
      const poolTx = Transaction.fromHex(promisedPool.hex);
      const connector = poolTx.outs.at(promisedPool.connectors.at(0));
      const connectorAmount = ElementsValue.fromBytes(connector.value).number;
      const redeemedAmount = ElementsValue.fromBytes(redeemOutput.value).number;

      const forfeitPset = Creator.newPset({
        outputs: [
          new CreatorOutput(
            this.network.assetHash,
            connectorAmount + redeemedAmount - 500,
            this.wallet.getChangeScriptPubKey()
          ),
          new CreatorOutput(this.network.assetHash, 500),
        ],
      });

      const updater = new Updater(forfeitPset);
      updater.addInputs([
        {
          txid: poolTx.getId(),
          txIndex: promisedPool.connectors.at(0),
          witnessUtxo: connector,
          sighashType: Transaction.SIGHASH_ALL,
        },
        {
          txid: tx.getId(),
          txIndex: tx_pos,
          witnessUtxo: redeemOutput,
          sighashType: Transaction.SIGHASH_DEFAULT,
          tapLeafScript: redeemTree.forfeitLeaf,
        },
      ]);

      const signed = this.wallet.sign(updater.pset);
      new Finalizer(signed)
        .finalizeInput(0)
        .finalizeInput(
          1,
          ForfeitScript.finalizer(
            forfeit.msg,
            sig,
            Buffer.from(forfeit.sig, 'hex')
          )
        );

      const forfeitTx = Extractor.extract(signed);
      const forfeitTxHex = forfeitTx.toHex();
      const id = await this.chain.broadcastTransaction(forfeitTxHex);
      await this.repository.updateConnectors(
        poolTx.getId(),
        promisedPool.connectors.slice(1)
      );
      broadcastedTxIDs.push(id);
    }

    return broadcastedTxIDs;
  }
}
