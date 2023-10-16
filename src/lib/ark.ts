import {
  AssetHash,
  bip341,
  Creator,
  CreatorOutput,
  crypto,
  ElementsValue,
  FinalizeFunc,
  networks,
  Pset,
  TapLeafScript,
  Transaction,
  Updater,
  UpdaterInput,
} from 'liquidjs-lib';
import { BufferWriter } from 'liquidjs-lib/src/bufferutils';
import {
  extractSharedUtxo,
  findLeafIncludingScript,
  sharedCoinTree,
  Stakeholder,
} from 'shared-utxo-covenant';
import * as ecc from 'tiny-secp256k1';

import { bip68 } from './bip68';
import {
  ForfeitMessage,
  LiftArgs,
  RedeemTaprootTree,
  UnsignedPoolTransaction,
  VirtualTransfer,
  VirtualUtxo,
  VirtualUtxoTaprootTree,
  Wallet,
} from './core';
import {
  CheckSequenceVerifyScript,
  ForfeitScript,
  FrozenReceiverScript,
} from './script';

export const H_POINT: Buffer = Buffer.from(
  '0250929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0',
  'hex'
);

export const X_H_POINT = H_POINT.subarray(1);

export const DUST = 400;

type vUtxoRedeem = {
  redeemTree: RedeemTaprootTree;
  redeemLeaf: bip341.TaprootLeaf;
};

const CLAIM_TIMEOUT = bip68(60 * 60 * 24 * 30); // 30 days
const REDEEM_TIMEOUT = bip68(60 * 60 * 24 * 15); // 15 days

// ASP_FEE should be much lower! this value is just to avoid dust outputs
const CHAIN_FEE = 500;

export function createLiftTransaction(
  aspPublicKey: Buffer,
  orders: LiftArgs[],
  network: networks.Network,
  minerFee = CHAIN_FEE,
  aspClaimTimeout = CLAIM_TIMEOUT,
  redeemTimeout = REDEEM_TIMEOUT
): Omit<UnsignedPoolTransaction, 'connectors'> {
  const inputs: UpdaterInput[] = [];
  const stakeHolders: Stakeholder[] = [];
  const outputs: CreatorOutput[] = [];
  const vUtxoTask: vUtxoRedeem[] = [];

  const minerFeeByOrder = Math.ceil(minerFee / orders.length);

  const claimLeaf = vUtxoClaimLeaf(aspPublicKey.subarray(1), aspClaimTimeout);

  for (const order of orders) {
    const vUtxoRedeem = vUtxoRedeemPath(
      aspPublicKey.subarray(1),
      order.vUtxoPublicKey.subarray(1),
      redeemTimeout
    );

    const inputsAmount = sumInputValues(order.coins);
    const liftedAmount = order.change
      ? inputsAmount - order.change.amount
      : inputsAmount;
    if (liftedAmount <= minerFeeByOrder)
      throw new Error('order amount is too low');

    stakeHolders.push({
      amount: liftedAmount - minerFeeByOrder,
      leaves: [vUtxoRedeem.redeemLeaf],
    });

    if (order.change) {
      outputs.push(order.change);
    }

    inputs.push(...order.coins);
    vUtxoTask.push(vUtxoRedeem);
  }

  // create the shared output with all stakeholders
  const taprootTree = sharedCoinTree(stakeHolders, [claimLeaf]);
  const sharedOutputScript = bip341
    .BIP341Factory(ecc)
    .taprootOutputScript(H_POINT, taprootTree);

  const totalAmount = stakeHolders.reduce((acc, s) => acc + s.amount, 0);

  outputs.unshift(
    new CreatorOutput(network.assetHash, totalAmount, sharedOutputScript)
  );

  // add the miner fee
  outputs.push(
    new CreatorOutput(network.assetHash, minerFeeByOrder * orders.length)
  );

  const pset = Creator.newPset({ outputs });
  const updater = new Updater(pset);
  updater.addInputs(inputs);

  const unsignedTransaction = updater.pset.unsignedTx();
  const txID = unsignedTransaction.getId();

  // craft the redeem txs
  const leaves: UnsignedPoolTransaction['leaves'] = new Map();

  const vUtxo = {
    txid: txID,
    txIndex: 0,
    tapInternalKey: H_POINT.subarray(1),
    witnessUtxo: unsignedTransaction.outs[0],
    sighashType: Transaction.SIGHASH_DEFAULT,
  };

  for (const task of vUtxoTask) {
    const vUtxoOwner = CheckSequenceVerifyScript.decompile(
      task.redeemTree.claimLeaf.script
    ).ownerPublicKey;

    leaves.set(vUtxoOwner.toString('hex'), {
      vUtxoTree: vUtxoTree(taprootTree, task.redeemLeaf, claimLeaf),
      redeemTree: task.redeemTree,
    });
  }

  return {
    unsignedPoolPset: updater.pset.toBase64(),
    leaves,
    vUtxo,
  };
}

/**
 * Creates an unsigned pool transaction including onboard orders + send orders
 * @param wallet ASP wallet
 * @param onboards set of onboards to include in the pset
 * @param transfers set of transfers to include in the pset
 */
export async function createPoolTransaction(
  wallet: Wallet,
  transfers: VirtualTransfer[],
  network: networks.Network,
  aspClaimTimeout = CLAIM_TIMEOUT,
  redeemTimeout = REDEEM_TIMEOUT,
  minerFee = CHAIN_FEE
): Promise<UnsignedPoolTransaction> {
  const stakeHolders: Stakeholder[] = [];

  const vUtxos: vUtxoRedeem[] = [];

  const claimLeaf = vUtxoClaimLeaf(
    wallet.getPublicKey().subarray(1),
    aspClaimTimeout
  );

  for (const transfer of transfers) {
    const vUtxoLeaves = vUtxoRedeemPath(
      wallet.getPublicKey().subarray(1),
      transfer.toPublicKey.subarray(1),
      redeemTimeout
    );

    const coinValue = vUtxoAmount(transfer);
    if (transfer.amount && coinValue < transfer.amount)
      throw new Error(
        `vUtxo amount ${coinValue} too low to cover the send amount ${transfer.amount}`
      );

    stakeHolders.push({
      amount: transfer.amount ? transfer.amount : coinValue,
      leaves: [vUtxoLeaves.redeemLeaf],
    });
    vUtxos.push(vUtxoLeaves);

    // create the change vUTXO
    if (transfer.amount && coinValue - transfer.amount > 0) {
      const ownerPubKey = FrozenReceiverScript.decompile(
        transfer.redeemLeaf.script
      ).ownerPublicKey;

      const vUtxoLeaves = vUtxoRedeemPath(
        wallet.getPublicKey().subarray(1),
        ownerPubKey,
        redeemTimeout
      );

      stakeHolders.push({
        amount: coinValue - transfer.amount,
        leaves: [vUtxoLeaves.redeemLeaf],
      });
      vUtxos.push(vUtxoLeaves);
    }
  }

  // create the shared output with all stakeholders
  const taprootTree = sharedCoinTree(stakeHolders, [claimLeaf]);
  const sharedOutputScript = bip341
    .BIP341Factory(ecc)
    .taprootOutputScript(H_POINT, taprootTree);

  const totalAmount = stakeHolders.reduce((acc, s) => acc + s.amount, 0);

  const connector = new CreatorOutput(
    network.assetHash,
    DUST,
    wallet.getChangeScriptPubKey()
  );
  const connectorsOutputs = new Array(transfers.length).fill(connector);
  const connAmount = DUST * connectorsOutputs.length;

  // coin select liquidity
  const { coins, change } = await wallet.coinSelect(
    totalAmount + minerFee + connAmount,
    network.assetHash
  );

  const pset = Creator.newPset({
    outputs: [
      new CreatorOutput(network.assetHash, totalAmount, sharedOutputScript),
      new CreatorOutput(network.assetHash, minerFee),
      ...connectorsOutputs,
    ],
  });

  const connectorsIndexes = Array.from(
    { length: connectorsOutputs.length },
    (_, i) => i + 2
  );

  const updater = new Updater(pset);
  updater.addInputs(coins);
  if (change) updater.addOutputs([change]);

  const unsignedTransaction = updater.pset.unsignedTx();
  const txID = unsignedTransaction.getId();

  // craft the redeem txs
  const leaves: UnsignedPoolTransaction['leaves'] = new Map();

  const vUtxo = {
    txid: txID,
    txIndex: 0,
    tapInternalKey: H_POINT.subarray(1),
    witnessUtxo: unsignedTransaction.outs[0],
    sighashType: Transaction.SIGHASH_DEFAULT,
  };

  for (const task of vUtxos) {
    const vUtxoOwner = CheckSequenceVerifyScript.decompile(
      task.redeemTree.claimLeaf.script
    ).ownerPublicKey;

    leaves.set(vUtxoOwner.toString('hex'), {
      vUtxoTree: vUtxoTree(taprootTree, task.redeemLeaf, claimLeaf),
      redeemTree: task.redeemTree,
    });
  }

  return {
    unsignedPoolPset: updater.pset.toBase64(),
    leaves,
    connectors: connectorsIndexes,
    vUtxo,
  };
}

/**
 * Unilateral exit via redeem tree
 * @param vUtxo vUtxo to send to the redeem tree
 * @param toRedeemLeaf vUtxo redeem leaf
 * @returns Pset unsigned without fee output
 */
export function makeRedeemTransaction(
  vUtxo: VirtualUtxo,
  toRedeemLeaf: VirtualUtxoTaprootTree['redeemLeaf']
): [Pset, FinalizeFunc] {
  const toRedeemScript = FrozenReceiverScript.decompile(toRedeemLeaf.script);

  const redeemScriptPubKey = Buffer.concat([
    Buffer.from([0x51, 0x20]),
    toRedeemScript.witnessProgram,
  ]);

  const sharedUtxo = extractSharedUtxo(toRedeemLeaf.script);

  const outputs = [
    new CreatorOutput(
      AssetHash.fromBytes(vUtxo.witnessUtxo.asset).hex,
      ElementsValue.fromBytes(vUtxo.witnessUtxo.value).number,
      redeemScriptPubKey
    ),
  ];

  if (sharedUtxo) {
    outputs.unshift(
      new CreatorOutput(
        AssetHash.fromBytes(vUtxo.witnessUtxo.asset).hex,
        sharedUtxo.amount,
        Buffer.concat([
          Buffer.from([0x51, 0x20]),
          sharedUtxo.taprootWitnessProgram,
        ])
      )
    );
  }

  const pset = Creator.newPset({
    outputs,
  });

  const updater = new Updater(pset);
  updater.addInputs([
    {
      ...vUtxo,
      tapLeafScript: toRedeemLeaf,
    },
  ]);

  return [updater.pset, FrozenReceiverScript.finalizer(sharedUtxo ? 1 : 0)];
}

// In order to lost rights on vUtxo redeem, user has to sign the hash of a ForfeitMessage
export function hashForfeitMessage(msg: ForfeitMessage) {
  const writer = BufferWriter.withCapacity(32 + 4 + 32);
  writer.writeSlice(Buffer.from(msg.vUtxoTxID, 'hex').reverse());
  writer.writeUInt32(msg.vUtxoIndex);
  writer.writeSlice(Buffer.from(msg.promisedPoolTxID, 'hex').reverse());
  return crypto.sha256(writer.buffer);
}

function vUtxoAmount({
  vUtxo,
  redeemLeaf,
}: Omit<VirtualTransfer, 'toPublicKey'>): number {
  let amount = ElementsValue.fromBytes(vUtxo.witnessUtxo.value).number;
  const changeData = extractSharedUtxo(redeemLeaf.script);
  if (changeData) {
    amount -= changeData.amount;
  }

  return amount;
}

function toTapLeafScript(
  leaf: bip341.TaprootLeaf,
  tree: bip341.HashTree
): TapLeafScript {
  const leafInTree = findLeafIncludingScript(tree, leaf.scriptHex);
  if (!leafInTree) {
    throw new Error('leaf not found in tree');
  }

  const path = bip341.findScriptPath(tree, bip341.tapLeafHash(leafInTree));
  const [script, controlBlock] = bip341
    .BIP341Factory(ecc)
    .taprootSignScriptStack(H_POINT, leafInTree, tree.hash, path);

  return {
    script,
    controlBlock,
    leafVersion: bip341.LEAF_VERSION_TAPSCRIPT,
  };
}

function vUtxoTree(
  vUtxoTree: bip341.HashTree,
  redeemLeaf: bip341.TaprootLeaf,
  claimLeaf: bip341.TaprootLeaf
): VirtualUtxoTaprootTree {
  return {
    claimLeaf: toTapLeafScript(claimLeaf, vUtxoTree),
    redeemLeaf: toTapLeafScript(redeemLeaf, vUtxoTree),
  };
}

function vUtxoClaimLeaf(
  serviceProviderPublicKey: Buffer,
  claimTimeout: Buffer
): bip341.TaprootLeaf {
  if (serviceProviderPublicKey.length !== 32) {
    throw new Error('serviceProviderPublicKey must be 32 bytes');
  }

  const scriptHex = new CheckSequenceVerifyScript(
    serviceProviderPublicKey,
    claimTimeout
  )
    .compile()
    .toString('hex');

  return {
    scriptHex,
  };
}

function vUtxoRedeemPath(
  serviceProviderPublicKey: Buffer,
  vUtxoPublicKey: Buffer,
  redeemTimeout: Buffer
): vUtxoRedeem {
  if (serviceProviderPublicKey.length !== 32) {
    throw new Error('serviceProviderPublicKey must be 32 bytes');
  }
  if (vUtxoPublicKey.length !== 32) {
    throw new Error('vUtxoPublicKey must be 32 bytes');
  }

  const { outputScript, redeemTree } = redeemPath(
    serviceProviderPublicKey,
    vUtxoPublicKey,
    redeemTimeout
  );

  // must send all to the redeem output script
  const toRedeem = new FrozenReceiverScript(
    vUtxoPublicKey,
    outputScript.subarray(2)
  )
    .compile()
    .toString('hex');

  const redeemLeaf = { scriptHex: toRedeem };

  return {
    redeemLeaf,
    redeemTree,
  };
}

export function redeemPath(
  serviceProviderPublicKey: Buffer,
  vUtxoPublicKey: Buffer,
  redeemTimeout: Buffer = REDEEM_TIMEOUT
) {
  if (serviceProviderPublicKey.length !== 32) {
    throw new Error('serviceProviderPublicKey must be 32 bytes');
  }

  if (vUtxoPublicKey.length !== 32) {
    throw new Error('vUtxoPublicKey must be 32 bytes');
  }

  const redeemTree = redeemTxTapTree(
    serviceProviderPublicKey,
    vUtxoPublicKey,
    redeemTimeout
  );
  const outputScript = bip341
    .BIP341Factory(ecc)
    .taprootOutputScript(H_POINT, redeemTree.tree);
  return { outputScript, redeemTree };
}

function redeemTxTapTree(
  serviceProviderPubKey: Buffer,
  vUtxoPublicKey: Buffer,
  redeemTimeout: Buffer
): RedeemTaprootTree {
  const forfeit = new ForfeitScript(vUtxoPublicKey, serviceProviderPubKey)
    .compile()
    .toString('hex');

  const claim = new CheckSequenceVerifyScript(vUtxoPublicKey, redeemTimeout)
    .compile()
    .toString('hex');

  const claimLeaf = { scriptHex: claim };
  const forfeitLeaf = { scriptHex: forfeit };

  const leaves = [forfeitLeaf, claimLeaf];

  const tree = bip341.toHashTree(leaves, true);

  const forfeitLeafHash = bip341.tapLeafHash(forfeitLeaf);
  const claimLeafHash = bip341.tapLeafHash(claimLeaf);

  const forfeitPath = bip341.findScriptPath(tree, forfeitLeafHash);
  const claimPath = bip341.findScriptPath(tree, claimLeafHash);

  const [forfeitScript, forfeitControlBlock] = bip341
    .BIP341Factory(ecc)
    .taprootSignScriptStack(H_POINT, forfeitLeaf, tree.hash, forfeitPath);

  const [claimScript, claimControlBlock] = bip341
    .BIP341Factory(ecc)
    .taprootSignScriptStack(H_POINT, claimLeaf, tree.hash, claimPath);

  return {
    tree,
    claimLeaf: {
      controlBlock: claimControlBlock,
      leafVersion: bip341.LEAF_VERSION_TAPSCRIPT,
      script: claimScript,
    },
    forfeitLeaf: {
      controlBlock: forfeitControlBlock,
      leafVersion: bip341.LEAF_VERSION_TAPSCRIPT,
      script: forfeitScript,
    },
  };
}

function sumInputValues(inputs: UpdaterInput[]): number {
  let value = 0;
  for (const input of inputs) {
    if (!input.witnessUtxo) {
      throw new Error('input must have witnessUtxo');
    }

    const v = ElementsValue.fromBytes(input.witnessUtxo.value);
    if (v.isConfidential) {
      throw new Error('input must not be confidential');
    }

    value += v.number;
  }

  return value;
}
