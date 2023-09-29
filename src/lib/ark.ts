import {
  AssetHash,
  bip341,
  script as bscript,
  Creator,
  CreatorOutput,
  crypto,
  ElementsValue,
  networks,
  Pset,
  Transaction,
  Updater,
  UpdaterInput,
  UpdaterOutput,
} from 'liquidjs-lib';
import { BufferWriter } from 'liquidjs-lib/src/bufferutils';
import { OPS } from 'liquidjs-lib/src/ops';
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

const CLAIM_TIMEOUT_SECONDS = 60 * 60 * 24 * 30; // 30 days
const CLAIM_TIMEOUT = bip68(
  CLAIM_TIMEOUT_SECONDS - (CLAIM_TIMEOUT_SECONDS % 512)
);

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
  network: networks.Network
): Promise<UnsignedPoolTransaction> {
  const inputs: UpdaterInput[] = [];
  const outputs: CreatorOutput[] = [];

  const vUtxoTask: {
    vUtxoKey: Buffer;
    refundKey: Buffer;
    vUtxoTree: VirtualUtxoTaprootTree;
    redeemTree: RedeemTaprootTree;
    vout: number;
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
    const [vUtxoTree, redeemTree] = vUtxoTapTree(
      wallet.getPublicKey(),
      order.vUtxoPublicKey
    );

    const refundKey = Buffer.from(
      ecc.pointAdd(wallet.getPublicKey(), order.vUtxoPublicKey)
    );

    const covenantScriptPubKey = bip341
      .BIP341Factory(ecc)
      .taprootOutputScript(refundKey, vUtxoTree.tree);

    const asset = AssetHash.fromBytes(order.coins[0].witnessUtxo.asset);
    if (asset.isConfidential) {
      throw new Error('asset must not be confidential');
    }

    inputs.push(...order.coins);

    const vout =
      outputs.push(
        new CreatorOutput(
          asset.hex,
          sumInputValues(order.coins),
          covenantScriptPubKey
        )
      ) - 1;

    vUtxoTask.push({
      vUtxoKey: order.vUtxoPublicKey,
      refundKey: refundKey.subarray(1),
      vUtxoTree,
      redeemTree,
      vout,
    });
  }

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
  updater.addOutputs(
    feesCoinSelection.change
      ? [feesCoinSelection.change, ...connectorsOutputs]
      : connectorsOutputs
  );

  const unsignedTransaction = updater.pset.unsignedTx();
  const txID = unsignedTransaction.getId();

  // craft the redeem txs
  const vUtxos: UnsignedPoolTransaction['vUtxos'] = new Map();

  for (const task of vUtxoTask) {
    const vUtxo = {
      txid: txID,
      txIndex: task.vout,
      tapInternalKey: task.refundKey,
      witnessUtxo: unsignedTransaction.outs[task.vout],
      sighashType: Transaction.SIGHASH_DEFAULT,
    };

    vUtxos.set(task.vUtxoKey.toString('hex'), {
      vUtxo,
      vUtxoTree: task.vUtxoTree,
      redeemTree: task.redeemTree,
    });
  }

  return {
    unsignedPoolPset: updater.pset.toBase64(),
    vUtxos,
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

function vUtxoTapTree(
  serviceProviderPublicKey: Buffer,
  vUtxoPublicKey: Buffer
): [VirtualUtxoTaprootTree, RedeemTaprootTree] {
  if (serviceProviderPublicKey.length !== 33) {
    throw new Error('serviceProviderPublicKey must be 33 bytes');
  }
  if (vUtxoPublicKey.length !== 33) {
    throw new Error('vUtxoPublicKey must be 33 bytes');
  }

  // after CLAIM_TIMEOUT, the ASP should be able to claim the utxo
  const claim = bscript
    .compile([
      CLAIM_TIMEOUT,
      OPS.OP_CHECKSEQUENCEVERIFY,
      serviceProviderPublicKey.subarray(1),
      OPS.OP_CHECKSIG,
    ])
    .toString('hex');

  const refundKey = Buffer.from(
    ecc.pointAdd(serviceProviderPublicKey, vUtxoPublicKey)
  );

  const redeemTree = redeemTxTapTree(serviceProviderPublicKey, vUtxoPublicKey);
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

  const leaves: bip341.TaprootLeaf[] = [
    { scriptHex: claim },
    { scriptHex: toRedeem },
  ];

  const tree = bip341.toHashTree(leaves, true);

  const claimLeafHash = bip341.tapLeafHash(leaves[0]);
  const redeemLeafHash = bip341.tapLeafHash(leaves[1]);

  const redeemPath = bip341.findScriptPath(tree, redeemLeafHash);
  const claimPath = bip341.findScriptPath(tree, claimLeafHash);

  const [redeemScript, controlBlock] = bip341
    .BIP341Factory(ecc)
    .taprootSignScriptStack(refundKey, leaves[0], tree.hash, redeemPath);

  const [claimScript, claimControlBlock] = bip341
    .BIP341Factory(ecc)
    .taprootSignScriptStack(refundKey, leaves[1], tree.hash, claimPath);

  return [
    {
      redeemLeaf: {
        controlBlock,
        leafVersion: bip341.LEAF_VERSION_TAPSCRIPT,
        script: redeemScript,
      },
      claimLeaf: {
        controlBlock: claimControlBlock,
        leafVersion: bip341.LEAF_VERSION_TAPSCRIPT,
        script: claimScript,
      },
      tree,
    },
    redeemTree,
  ];
}

function redeemTxTapTree(
  serviceProviderPubKey: Buffer,
  vUtxoPublicKey: Buffer
): RedeemTaprootTree {
  const forfeit = bscript
    .compile([
      // [aspSignature, signature, outpoint, promisedTxId]
      OPS.OP_DUP,
      // [aspSignature, signature, outpoint, promisedTxId, promisedTxId]
      OPS.OP_2,
      OPS.OP_ROLL,
      // [aspSignature, signature, promisedTxId, promisedTxId, outpoint]
      OPS.CAT,
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
      vUtxoPublicKey,
      OPS.OP_CHECKSIGFROMSTACKVERIFY,
      // [aspSignature, promisedTxId, hash]
      OPS.OP_2,
      OPS.OP_ROLL,
      // [promisedTx, hash, aspSignature]
      OPS.OP_SWAP,
      // [promisedTx, aspSignature, hash]
      serviceProviderPubKey,
      OPS.OP_CHECKSIGFROMSTACKVERIFY,

      // [promisedTxId]
      OPS.OP_0,
      OPS.OP_INSPECTINPUTOUTPOINT,
      OPS.OP_DROP, // drop the input flag
      OPS.OP_DROP, // drop the input vout
      OPS.OP_EQUAL, // check that input 0 is the promised tx ID
    ])
    .toString('hex');

  const claim = makeTimelockedScriptLeaf(vUtxoPublicKey, CLAIM_TIMEOUT);

  const leaves = [{ scriptHex: forfeit }, claim];

  const tree = bip341.toHashTree(leaves, true);

  const forfeitLeafHash = bip341.tapLeafHash(leaves[0]);
  const claimLeafHash = bip341.tapLeafHash(leaves[1]);

  const forfeitPath = bip341.findScriptPath(tree, forfeitLeafHash);
  const claimPath = bip341.findScriptPath(tree, claimLeafHash);

  const refundKey = Buffer.from(
    ecc.pointAdd(serviceProviderPubKey, vUtxoPublicKey)
  );

  const [forfeitScript, forfeitControlBlock] = bip341
    .BIP341Factory(ecc)
    .taprootSignScriptStack(refundKey, leaves[0], tree.hash, forfeitPath);

  const [claimScript, claimControlBlock] = bip341
    .BIP341Factory(ecc)
    .taprootSignScriptStack(refundKey, leaves[1], tree.hash, claimPath);

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
