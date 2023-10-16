import { bip341, Extractor, Finalizer, networks, Pset } from 'liquidjs-lib';
import { computeMerkleRoot, taprootWitnessProgram } from 'shared-utxo-covenant';
import { verifySchnorr } from 'tiny-secp256k1';

import {
  createPoolTransaction,
  hashForfeitMessage,
  redeemPath,
  X_H_POINT,
} from './ark';
import {
  ExtendedVirtualUtxo,
  ForfeitMessage,
  UnsignedPoolTransaction,
  VirtualTransfer,
  Wallet,
} from './core';
import {
  CheckSequenceVerifyScript,
  ForfeitScript,
  FrozenReceiverScript,
} from './script';

export interface PoolManager {
  sendRequest(
    vUtxo: ExtendedVirtualUtxo,
    toPublicKey: Buffer,
    amount?: number
  ): Promise<{
    nextPoolPset: string;
    forfeitMessage: ForfeitMessage;
    receiverUtxo: ExtendedVirtualUtxo;
    changeUtxo?: ExtendedVirtualUtxo;
  }>;
  send(forfeitMessage: ForfeitMessage, signature: string): Promise<string>;
}

export interface PoolManagerRepository {
  setForfeit(
    redeemScriptPubKey: string,
    forfeitMessage: ForfeitMessage,
    signature: string
  ): Promise<void>;
  setPoolTransaction(txHex: string, connectors: number[]): Promise<void>;
}

export const PoolManagerFactory = (
  wallet: Wallet,
  repository: PoolManagerRepository,
  network: networks.Network,
  interval = 5000
): PoolManager => new _Implementation(wallet, repository, network, interval);

class _Implementation implements PoolManager {
  private queue: (VirtualTransfer & {
    signerPublicKey: Buffer;
    resolve: (value: Awaited<ReturnType<PoolManager['sendRequest']>>) => void;
    reject: (reason: unknown) => void;
  })[] = [];
  private timer: NodeJS.Timeout | null = null;
  private pendingPool: Map<
    string,
    {
      pset: Pset;
      connectors: UnsignedPoolTransaction['connectors'];
      toForfeit: { txID: string; txIndex: number; ownerPublicKey: Buffer }[];
      signatures: {
        redeemScriptPubKey: string;
        msg: ForfeitMessage;
        signature: string;
        resolve: (v: string) => void;
        reject: (e: unknown) => void;
      }[];
    }
  > = new Map();

  constructor(
    private wallet: Wallet,
    private repository: PoolManagerRepository,
    private network: networks.Network,
    private interval: number
  ) {}

  sendRequest(
    { redeemTree, vUtxo, vUtxoTree }: ExtendedVirtualUtxo,
    toPublicKey: Buffer,
    amount?: number
  ): Promise<{
    nextPoolPset: string;
    forfeitMessage: ForfeitMessage;
    receiverUtxo: ExtendedVirtualUtxo;
  }> {
    // validate vUtxo
    this.validate({ vUtxo, redeemTree, vUtxoTree });
    const signerPublicKey = CheckSequenceVerifyScript.decompile(
      redeemTree.claimLeaf.script
    ).ownerPublicKey;

    return new Promise((resolve, reject) => {
      this.queue.push({
        signerPublicKey,
        amount,
        vUtxo,
        toPublicKey,
        redeemLeaf: vUtxoTree.redeemLeaf,
        resolve,
        reject,
      });
      // if the timer is not running, start it
      if (!this.timerIsRunning()) {
        this.timer = setTimeout(() => {
          const queueState = [...this.queue];
          this.queue = [];
          this.timer = null;

          this.processSendOrders(queueState);
        }, this.interval);
      }
    });
  }

  send(forfeitMessage: ForfeitMessage, signature: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const pendingPool = this.pendingPool.get(forfeitMessage.promisedPoolTxID);
      if (!pendingPool) {
        reject('pool tx not found');
      }

      const vUtxoIndex = pendingPool.toForfeit.findIndex(
        (u) =>
          u.txIndex === forfeitMessage.vUtxoIndex &&
          u.txID === forfeitMessage.vUtxoTxID
      );
      if (vUtxoIndex === -1) {
        reject(
          `vUtxo not found in pending pool tx ${forfeitMessage.promisedPoolTxID}`
        );
      }

      const { ownerPublicKey } = pendingPool.toForfeit[vUtxoIndex];

      if (
        !verifySchnorr(
          hashForfeitMessage(forfeitMessage),
          ownerPublicKey,
          Buffer.from(signature, 'hex')
        )
      ) {
        reject('invalid signature');
      }

      const { pset, signatures } = pendingPool;

      const { outputScript } = redeemPath(
        this.wallet.getPublicKey().subarray(1),
        ownerPublicKey
      );

      signatures.push({
        msg: forfeitMessage,
        signature,
        redeemScriptPubKey: outputScript.toString('hex'),
        resolve,
        reject,
      });

      const remainingSigs = pendingPool.toForfeit.filter(
        (_, i) => i !== vUtxoIndex
      );

      if (remainingSigs.length > 0) {
        this.pendingPool.set(forfeitMessage.promisedPoolTxID, {
          pset,
          signatures,
          connectors: pendingPool.connectors,
          toForfeit: remainingSigs,
        });
      }

      try {
        if (remainingSigs.length === 0) {
          // all signatures collected, time to sign and finalize the pool tx

          const signed = this.wallet.sign(pset);
          new Finalizer(signed).finalize();
          const hex = Extractor.extract(signed).toHex();
          this.pendingPool.delete(forfeitMessage.promisedPoolTxID);

          // store the pool tx in the repository
          this.repository
            .setPoolTransaction(hex, pendingPool.connectors)
            .then(() =>
              Promise.all(
                signatures.map(({ msg, signature, redeemScriptPubKey }) =>
                  this.repository.setForfeit(redeemScriptPubKey, msg, signature)
                )
              )
            )
            .then(() => signatures.forEach(({ resolve }) => resolve(hex)))
            .catch((e) => signatures.forEach(({ reject }) => reject(e)));
        }
      } catch (e) {
        signatures.forEach(({ reject }) => reject(e));
      }
    });
  }

  private timerIsRunning() {
    return this.timer !== null;
  }

  private async processSendOrders(orders: typeof this.queue) {
    if (orders.length === 0) {
      return;
    }

    let txID: string;

    try {
      const {
        leaves,
        connectors,
        unsignedPoolPset,
        vUtxo: newUtxo,
      } = await createPoolTransaction(this.wallet, orders, this.network);

      const ordersWithReceiverUtxo: {
        order: (typeof orders)[number];
        receiverUtxo: ExtendedVirtualUtxo;
        changeUtxo?: ExtendedVirtualUtxo;
      }[] = [];

      for (const { toPublicKey, signerPublicKey } of orders) {
        const index = ordersWithReceiverUtxo.length;
        const vUtxoLeaves = leaves.get(toPublicKey.subarray(1).toString('hex'));
        if (!vUtxoLeaves) {
          throw new Error('malformed pool tx');
        }

        const changeVUtxoLeaves = leaves.get(signerPublicKey.toString('hex'));

        ordersWithReceiverUtxo.push({
          order: orders[index],
          receiverUtxo: {
            vUtxo: newUtxo,
            ...vUtxoLeaves,
          },
          changeUtxo: changeVUtxoLeaves
            ? { vUtxo: newUtxo, ...changeVUtxoLeaves }
            : undefined,
        });
      }

      const partialTx = Pset.fromBase64(unsignedPoolPset);
      txID = partialTx.unsignedTx().getId();

      // set the signing pool tx before resolving the orders
      this.pendingPool.set(txID, {
        pset: partialTx,
        signatures: [],
        toForfeit: orders.map(({ vUtxo, signerPublicKey }) => ({
          txID: vUtxo.txid,
          txIndex: vUtxo.txIndex,
          ownerPublicKey: signerPublicKey,
        })),
        connectors,
      });

      for (const {
        order,
        receiverUtxo,
        changeUtxo,
      } of ordersWithReceiverUtxo) {
        order.resolve({
          nextPoolPset: unsignedPoolPset,
          forfeitMessage: {
            vUtxoTxID: order.vUtxo.txid,
            vUtxoIndex: order.vUtxo.txIndex,
            promisedPoolTxID: txID,
          },
          receiverUtxo,
          changeUtxo,
        });
      }
    } catch (e) {
      this.pendingPool.delete(txID);
      for (const { reject } of orders) {
        reject(e);
      }
    }
  }

  private validate({ vUtxo, redeemTree, vUtxoTree }: ExtendedVirtualUtxo) {
    // internal key should be unspendable
    if (!vUtxo.tapInternalKey.equals(X_H_POINT))
      throw new Error('invalid tapInternalKey');

    // validate claim to ASP
    const claimScript = CheckSequenceVerifyScript.decompile(
      vUtxoTree.claimLeaf.script
    );
    if (
      !claimScript.ownerPublicKey.equals(this.wallet.getPublicKey().subarray(1))
    ) {
      throw new Error('invalid vUtxo claim leaf');
    }

    // validate redeem leaf
    const redeemClaim = CheckSequenceVerifyScript.decompile(
      redeemTree.claimLeaf.script
    );
    // validate forfeit leaf
    const forfeit = ForfeitScript.decompile(redeemTree.forfeitLeaf.script);
    if (!forfeit.ownerPubKey.equals(redeemClaim.ownerPublicKey))
      throw new Error('invalid redeem tree');
    if (!forfeit.providerPubKey.equals(claimScript.ownerPublicKey))
      throw new Error('invalid redeem tree');

    // validate redeem root
    const redeemRoot = redeemTree.tree.hash;
    const expectedWitness = taprootWitnessProgram(X_H_POINT, redeemRoot);

    const toRedeem = FrozenReceiverScript.decompile(
      vUtxoTree.redeemLeaf.script
    );
    if (!toRedeem.ownerPublicKey.equals(redeemClaim.ownerPublicKey))
      throw new Error('invalid redeem tree');
    if (!toRedeem.witnessProgram.equals(expectedWitness))
      throw new Error('invalid redeem leaf');

    // validate vUtxo root
    const [root, rootFromClaim] = [
      vUtxoTree.redeemLeaf,
      vUtxoTree.claimLeaf,
    ].map(({ controlBlock, script }) =>
      computeMerkleRoot(
        controlBlock,
        bip341.tapLeafHash({ scriptHex: script.toString('hex') })
      )
    );

    if (!root.equals(rootFromClaim)) throw new Error('invalid vUtxo tree');

    const vUtxoScriptPubKey = vUtxo.witnessUtxo.script;
    const expectedWitnessProgram = taprootWitnessProgram(X_H_POINT, root);
    if (!vUtxoScriptPubKey.subarray(2).equals(expectedWitnessProgram))
      throw new Error('invalid vUtxo scriptPubKey');
  }
}
