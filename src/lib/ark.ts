import {
  AssetHash,
  bip341,
  script as bscript,
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
  UpdaterOutput,
  witnessStackToScriptWitness,
} from 'liquidjs-lib';
import { BufferWriter } from 'liquidjs-lib/src/bufferutils';
import { OPS } from 'liquidjs-lib/src/ops';
import {
  findLeafIncludingScript,
  sharedCoinTree,
  Stakeholder,
} from 'shared-utxo-covenant';
import * as ecc from 'tiny-secp256k1';

import { bip68 } from './bip68';
import {
  ForfeitMessage,
  OnboardOrder,
  RedeemTaprootTree,
  TransferOrder,
  UnsignedPoolTransaction,
  VirtualUtxo,
  VirtualUtxoTaprootTree,
  Wallet,
} from './core';
import { makeTimelockedScriptLeaf } from './script';

export const H_POINT: Buffer = Buffer.from(
  '0250929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0',
  'hex'
);

type vUtxoLeaves = {
  redeemTree: RedeemTaprootTree;
  redeemLeaf: bip341.TaprootLeaf;
  claimLeaf: bip341.TaprootLeaf;
};

const CLAIM_TIMEOUT = bip68(60 * 60 * 24 * 30); // 30 days
const REDEEM_TIMEOUT = bip68(60 * 60 * 24 * 15); // 15 days

// ASP_FEE should be much lower! this value is just to avoid dust outputs
const CHAIN_FEE = 500;

/**
 * Creates an unsigned pool transaction including onboard orders + send orders
 * @param wallet ASP wallet
 * @param onboards set of onboards to include in the pset
 * @param transfers set of transfers to include in the pset
 */
export async function createPoolTransaction(
  wallet: Wallet,
  onboards: OnboardOrder[],
  transfers: TransferOrder[],
  network: networks.Network,
  aspClaimTimeout = CLAIM_TIMEOUT,
  redeemTimeout = REDEEM_TIMEOUT
): Promise<UnsignedPoolTransaction> {
  const inputs: UpdaterInput[] = [];
  const stakeHolders: Stakeholder[] = [];
  const outputs: CreatorOutput[] = [];

  const vUtxoTask: {
    vUtxoKey: Buffer;
    vUtxoLeaves: vUtxoLeaves;
    redeemTree: RedeemTaprootTree;
  }[] = [];

  const toOnboard = toOnboardOrder(wallet);
  // convert transfers to onboard order to receiver
  // will coin select coin from ASP wallet
  const fromTransfers = await Promise.all(transfers.map(toOnboard));
  const onboardOrdersFromTransfer = fromTransfers.map(([o]) => o);

  const connectorsOutputs = fromTransfers
    .map(([, change]) => change)
    .filter((c) => c);

  for (const order of [...onboards, ...onboardOrdersFromTransfer]) {
    const vUtxoLeaves = vUtxoTaprootLeaves(
      wallet.getPublicKey(),
      order.vUtxoPublicKey,
      aspClaimTimeout,
      redeemTimeout
    );

    stakeHolders.push({
      amount: sumInputValues(order.coins),
      leaves: [vUtxoLeaves.claimLeaf, vUtxoLeaves.redeemLeaf],
    });

    inputs.push(...order.coins);

    vUtxoTask.push({
      redeemTree: vUtxoLeaves.redeemTree,
      vUtxoKey: order.vUtxoPublicKey,
      vUtxoLeaves,
    });
  }

  // create the shared output with all stakeholders
  const taprootTree = sharedCoinTree(stakeHolders);
  const sharedOutputScript = bip341
    .BIP341Factory(ecc)
    .taprootOutputScript(H_POINT, taprootTree);

  const totalAmount = stakeHolders.reduce((acc, s) => acc + s.amount, 0);

  outputs.push(
    new CreatorOutput(network.assetHash, totalAmount, sharedOutputScript)
  );

  // add the miner fee
  outputs.push(new CreatorOutput(network.assetHash, CHAIN_FEE));

  const pset = Creator.newPset({ outputs });

  // coin select from wallet to pay chain fee
  const feesCoinSelection = await wallet.coinSelect(
    CHAIN_FEE,
    network.assetHash
  );

  const updater = new Updater(pset);
  updater.addInputs([...inputs, ...feesCoinSelection.coins]);
  const nbOuts = updater.pset.outputs.length;
  const changeOutputs = feesCoinSelection.change
    ? connectorsOutputs.concat(feesCoinSelection.change)
    : connectorsOutputs;
  updater.addOutputs(changeOutputs);

  const connectorsIndexes = Array.from(
    { length: changeOutputs.length },
    (_, i) => nbOuts + i
  );

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
    leaves.set(task.vUtxoKey.toString('hex'), {
      vUtxoTree: vUtxoTree(taprootTree, task.vUtxoLeaves),
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
): Pset {
  const toRedeemScript = bscript.decompile(toRedeemLeaf.script);
  const redeemTaprootKey = toRedeemScript[toRedeemScript.length - 2];
  if (!Buffer.isBuffer(redeemTaprootKey) || redeemTaprootKey.length !== 32) {
    throw new Error(
      'witnessProgram is invalid in toRedeemLeaf: ' + redeemTaprootKey
    );
  }

  const redeemScriptPubKey = Buffer.concat([
    Buffer.from([0x51, 0x20]),
    redeemTaprootKey,
  ]);

  const pset = Creator.newPset({
    outputs: [
      new CreatorOutput(
        AssetHash.fromBytes(vUtxo.witnessUtxo.asset).hex,
        ElementsValue.fromBytes(vUtxo.witnessUtxo.value).number,
        redeemScriptPubKey
      ),
    ],
  });

  const updater = new Updater(pset);
  updater.addInputs([
    {
      ...vUtxo,
      tapLeafScript: toRedeemLeaf,
    },
  ]);

  return updater.pset;
}

// In order to lost rights on vUtxo redeem, user has to sign the hash of a ForfeitMessage
export function hashForfeitMessage(msg: ForfeitMessage) {
  const writer = BufferWriter.withCapacity(32 + 4 + 32);
  writer.writeSlice(Buffer.from(msg.vUtxoTxID, 'hex').reverse());
  writer.writeUInt32(msg.vUtxoIndex);
  writer.writeSlice(Buffer.from(msg.promisedPoolTxID, 'hex').reverse());
  return crypto.sha256(writer.buffer);
}

export function forfeitFinalizer(
  aspSig: Buffer,
  userSig: Buffer,
  msg: ForfeitMessage
): FinalizeFunc {
  return function (inIndex: number, pset: Pset) {
    const tapLeaf = pset.inputs[inIndex].tapLeafScript?.at(0);
    if (!tapLeaf) {
      throw new Error('input must have tapLeafScript');
    }

    const outpoint = BufferWriter.withCapacity(32 + 4);
    outpoint.writeSlice(Buffer.from(msg.vUtxoTxID, 'hex').reverse());
    outpoint.writeUInt32(msg.vUtxoIndex);

    const args = [
      // [aspSignature, signature, outpoint, promisedTxId]
      aspSig,
      userSig,
      outpoint.buffer,
      Buffer.from(msg.promisedPoolTxID, 'hex').reverse(),
    ];

    return {
      finalScriptWitness: witnessStackToScriptWitness(
        args.concat(tapLeaf.script).concat(tapLeaf.controlBlock)
      ),
    };
  };
}

function toOnboardOrder(
  wallet: Wallet
): (sendOrder: TransferOrder) => Promise<[OnboardOrder, UpdaterOutput?]> {
  return async (sendOrder) => {
    const { coins, change } = await wallet.coinSelect(
      ElementsValue.fromBytes(sendOrder.vUtxo.witnessUtxo.value).number,
      AssetHash.fromBytes(sendOrder.vUtxo.witnessUtxo.asset).hex
    );

    const onboardOrder = {
      coins,
      vUtxoPublicKey: sendOrder.toPublicKey,
    };

    return [onboardOrder, change];
  };
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
  leaves: vUtxoLeaves
): VirtualUtxoTaprootTree {
  return {
    claimLeaf: toTapLeafScript(leaves.claimLeaf, vUtxoTree),
    redeemLeaf: toTapLeafScript(leaves.redeemLeaf, vUtxoTree),
  };
}

function vUtxoTaprootLeaves(
  serviceProviderPublicKey: Buffer,
  vUtxoPublicKey: Buffer,
  aspClaimTimeout: Buffer,
  redeemTimeout: Buffer
): vUtxoLeaves {
  if (serviceProviderPublicKey.length !== 33) {
    throw new Error('serviceProviderPublicKey must be 33 bytes');
  }
  if (vUtxoPublicKey.length !== 33) {
    throw new Error('vUtxoPublicKey must be 33 bytes');
  }

  // after CLAIM_TIMEOUT, the ASP should be able to claim the utxo
  const claimLeaf = makeTimelockedScriptLeaf(
    serviceProviderPublicKey.subarray(1),
    aspClaimTimeout
  );

  const refundKey = Buffer.from(
    ecc.pointAdd(serviceProviderPublicKey, vUtxoPublicKey)
  );

  const redeemTree = redeemTxTapTree(
    serviceProviderPublicKey,
    vUtxoPublicKey,
    redeemTimeout
  );
  const outputScript = bip341
    .BIP341Factory(ecc)
    .taprootOutputScript(refundKey, redeemTree.tree);

  const witnessProgram = outputScript.subarray(2);

  // must send all to the redeem output script
  const toRedeem = bscript
    .compile([
      // [vUtxoOwnerSig]
      vUtxoPublicKey.subarray(1),
      OPS.OP_CHECKSIGVERIFY,

      OPS.OP_PUSHCURRENTINPUTINDEX,
      OPS.OP_INSPECTINPUTASSET,
      OPS.OP_CAT,
      // [asset+assetPrefix]
      OPS.OP_0,
      OPS.OP_INSPECTOUTPUTASSET,
      // [asset+assetPrefix, asset, assetPrefix]
      OPS.OP_CAT,
      // [asset+assetPrefix, asset+assetPrefix]
      OPS.OP_EQUALVERIFY,

      OPS.OP_PUSHCURRENTINPUTINDEX,
      OPS.OP_INSPECTINPUTVALUE,
      OPS.OP_CAT,
      // [value+valuePrefix]
      OPS.OP_0,
      OPS.OP_INSPECTOUTPUTVALUE,
      OPS.OP_CAT,
      OPS.OP_EQUALVERIFY,

      OPS.OP_0,
      OPS.OP_INSPECTOUTPUTSCRIPTPUBKEY,
      OPS.OP_1, // should be segwit v1
      OPS.OP_EQUALVERIFY,
      witnessProgram,
      OPS.OP_EQUAL,
    ])
    .toString('hex');

  const redeemLeaf = { scriptHex: toRedeem };

  return {
    claimLeaf,
    redeemLeaf,
    redeemTree,
  };
}

function redeemTxTapTree(
  serviceProviderPubKey: Buffer,
  vUtxoPublicKey: Buffer,
  redeemTimeout: Buffer
): RedeemTaprootTree {
  const forfeit = bscript
    .compile([
      // [aspSignature, signature, outpoint, promisedTxId]
      OPS.OP_DUP,
      // [aspSignature, signature, outpoint, promisedTxId, promisedTxId]
      OPS.OP_2,
      OPS.OP_ROLL,
      // [aspSignature, signature, promisedTxId, promisedTxId, outpoint]
      OPS.OP_SWAP,
      OPS.OP_CAT,
      // [aspSignature, signature, promisedTxId, outpoint+promisedTxId]
      OPS.OP_SHA256,
      // [aspSignature, signature, promisedTxId, hash]
      OPS.OP_DUP,
      // [aspSignature, signature, promisedTxId, hash, hash]
      OPS.OP_3,
      OPS.OP_ROLL,
      // [aspSignature, promisedTxId, hash, hash, signature]
      OPS.OP_SWAP,
      // [aspSignature, promisedTxId, hash, signature, hash]
      vUtxoPublicKey.subarray(1),
      OPS.OP_CHECKSIGFROMSTACKVERIFY,
      // [aspSignature, promisedTxId, hash]
      OPS.OP_2,
      OPS.OP_ROLL,
      // [promisedTx, hash, aspSignature]
      OPS.OP_SWAP,
      // [promisedTx, aspSignature, hash]
      serviceProviderPubKey.subarray(1),
      OPS.OP_CHECKSIGFROMSTACKVERIFY,

      // [promisedTxId]
      OPS.OP_0,
      OPS.OP_INSPECTINPUTOUTPOINT,
      OPS.OP_DROP, // drop the input flag
      OPS.OP_DROP, // drop the input vout
      OPS.OP_EQUAL, // check that input 0 is the promised tx ID
    ])
    .toString('hex');

  const claim = makeTimelockedScriptLeaf(
    vUtxoPublicKey.subarray(1),
    redeemTimeout
  );

  const forfeitLeaf = { scriptHex: forfeit };

  const leaves = [forfeitLeaf, claim];

  const tree = bip341.toHashTree(leaves, true);

  const forfeitLeafHash = bip341.tapLeafHash(forfeitLeaf);
  const claimLeafHash = bip341.tapLeafHash(claim);

  const forfeitPath = bip341.findScriptPath(tree, forfeitLeafHash);
  const claimPath = bip341.findScriptPath(tree, claimLeafHash);

  const refundKey = Buffer.from(
    ecc.pointAdd(serviceProviderPubKey, vUtxoPublicKey)
  );

  const [forfeitScript, forfeitControlBlock] = bip341
    .BIP341Factory(ecc)
    .taprootSignScriptStack(refundKey, forfeitLeaf, tree.hash, forfeitPath);

  const [claimScript, claimControlBlock] = bip341
    .BIP341Factory(ecc)
    .taprootSignScriptStack(refundKey, claim, tree.hash, claimPath);

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
