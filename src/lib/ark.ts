import {
  address,
  AssetHash,
  bip341,
  BIP371SigningData,
  script as bscript,
  Creator,
  CreatorOutput,
  crypto,
  ElementsValue,
  Extractor,
  Finalizer,
  Pset,
  Signer,
  TapLeafScript,
  Transaction,
  Updater,
  UpdaterInput,
  witnessStackToScriptWitness,
} from 'liquidjs-lib';
import { BufferWriter } from 'liquidjs-lib/src/bufferutils';
import { OPS } from 'liquidjs-lib/src/ops';
import * as ecc from 'tiny-secp256k1';

export const H_POINT: Buffer = Buffer.from(
  '0250929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0',
  'hex'
);

// ASP_FEE should be much lower! this value is just to avoid dust outputs
export const ASP_FEE = 1000;
const CHAIN_FEE = 500;

export type Outpoint = {
  txid: string;
  vout: number;
};

export type OnboardOrder = {
  coins: UpdaterInput[];
  redeemPublicKey: Buffer;
};

export type SendOrder = {
  address: string;
  amount: number;
  coin: UpdaterInput;
  signature: string;
  forfeitTx: string;
};

export type PoolTransactionBatch = {
  onboardOrders: OnboardOrder[];
  sendOrders: Pick<SendOrder, 'coin' | 'address'>[];
};

export type UnsignedPoolTransaction = {
  unsignedPoolPset: string; // the pool pset without the signatures
  redeems: Map<string, string>; // redeemPublicKey hex -> redeemPset signed by ASP
};

export type VirtualUtxoTaprootTree = {
  tree: bip341.HashTree;
  redeemLeaf: TapLeafScript;
  sendLeaf: TapLeafScript;
};

/**
 * create a pool transaction and the associated signed redeem txs
 * @param serviceProviderPayoutAddress address receiving sendOrder fee
 * @param serviceProviderPrivateKey used to sign redeem tx
 * @param batch contains send orders & onboard orders
 * @param genesisBlockHash used to sign elements schnorr sig
 * @returns redeems transactions mapped to their redeemPublicKey + the pool transaction unsigned
 */
export function createPoolTransaction(
  serviceProviderPayoutAddress: string,
  serviceProviderPrivateKey: Buffer,
  batch: PoolTransactionBatch,
  genesisBlockHash: Buffer,
  LBTC: string
): UnsignedPoolTransaction {
  const inputs: UpdaterInput[] = [];
  const outputs: CreatorOutput[] = [];

  const serviceProviderPublicKey = Buffer.from(
    ecc.pointFromScalar(serviceProviderPrivateKey, true)
  );

  const redeemTxTask: {
    vout: number;
    redeemLeaf: TapLeafScript;
    redeemPublicKey: Buffer;
    refundKey: Buffer;
  }[] = [];

  const nbOfOnboards = batch.onboardOrders.length;
  const chainFeePerOrder = Math.ceil(CHAIN_FEE / nbOfOnboards);
  const totalChainFee = chainFeePerOrder * nbOfOnboards;

  for (const order of batch.onboardOrders) {
    inputs.push(...order.coins);
    const { tree, redeemLeaf } = makeVirtualUtxoTaprootTree(
      serviceProviderPublicKey,
      order.redeemPublicKey
    );

    const refundKey = Buffer.from(
      ecc.pointAdd(serviceProviderPublicKey, order.redeemPublicKey)
    );

    const covenantScriptPubKey = bip341
      .BIP341Factory(ecc)
      .taprootOutputScript(refundKey, tree);

    const asset = AssetHash.fromBytes(order.coins[0].witnessUtxo.asset);
    if (asset.isConfidential) {
      throw new Error('asset must not be confidential');
    }

    outputs.push(
      new CreatorOutput(
        asset.hex,
        sumInputValues(order.coins) - chainFeePerOrder,
        covenantScriptPubKey
      )
    );

    redeemTxTask.push({
      refundKey: refundKey.subarray(1),
      vout: outputs.length - 1,
      redeemLeaf,
      redeemPublicKey: order.redeemPublicKey,
    });
  }

  for (const order of batch.sendOrders) {
    inputs.push(order.coin);
    // at sign step, asp will sign the signature
    // it also should keep an eye on the redeem tx, and if it is broadcasted, it should broadcast the forfeit tx
    outputs.push(
      new CreatorOutput(
        LBTC,
        ElementsValue.fromBytes(order.coin.witnessUtxo.value).number - ASP_FEE,
        address.toOutputScript(order.address)
      )
    );
  }

  if (batch.sendOrders.length) {
    // add the provider fee output
    outputs.push(
      new CreatorOutput(
        LBTC,
        ASP_FEE * batch.sendOrders.length - (nbOfOnboards ? 0 : CHAIN_FEE),
        address.toOutputScript(serviceProviderPayoutAddress)
      )
    );
  }

  // add the miner fee
  outputs.push(
    new CreatorOutput(LBTC, nbOfOnboards ? totalChainFee : CHAIN_FEE)
  );

  const pset = Creator.newPset({ outputs });
  const updater = new Updater(pset);
  updater.addInputs(inputs);

  const unsignedTransaction = updater.pset.unsignedTx();
  const txID = unsignedTransaction.getId();

  // craft the redeem txs
  const redeems = new Map<string, string>();

  for (const task of redeemTxTask) {
    const redeemTxInput: UpdaterInput = {
      txid: txID,
      txIndex: task.vout,
      tapInternalKey: task.refundKey,
      witnessUtxo: unsignedTransaction.outs[task.vout],
      tapLeafScript: task.redeemLeaf,
      sighashType: Transaction.SIGHASH_DEFAULT,
    };

    const redeemTx = makeRedeemTransaction(
      redeemTxInput,
      task.redeemPublicKey,
      serviceProviderPrivateKey,
      genesisBlockHash
    );

    redeems.set(task.redeemPublicKey.toString('hex'), redeemTx);
  }

  return {
    unsignedPoolPset: updater.pset.toBase64(),
    redeems,
  };
}

function makeTimelockedScriptLeaf(pubKey: Buffer) {
  const timelockedScript = bscript.compile([
    // TODO timelock this
    pubKey,
    OPS.OP_CHECKSIG,
  ]);

  return {
    scriptHex: timelockedScript.toString('hex'),
  };
}

/**
 * Create and sign a redeem tx
 * @param vUtxo associated to one of the pool tx output
 * @param redeemPublicKey public key of the owner
 * @param aspPrivateKey service provider locking the utxo
 * @returns redeem tx for vUtxo signed by asp
 */
function makeRedeemTransaction(
  vUtxo: UpdaterInput, // the index of the output to redeem
  redeemPublicKey: Buffer,
  aspPrivateKey: Buffer,
  genesisBlockHash: Buffer // elements schnorr sig needs genesis hash
): string {
  if (redeemPublicKey.length !== 33) {
    throw new Error('redeemPublicKey must be 33 bytes');
  }

  const tree = bip341.toHashTree([
    makeTimelockedScriptLeaf(redeemPublicKey.subarray(1)),
  ]);

  const redeemScriptPubKey = bip341
    .BIP341Factory(ecc)
    .taprootOutputScript(H_POINT, tree);

  const pset = Creator.newPset({
    outputs: [
      new CreatorOutput(
        AssetHash.fromBytes(vUtxo.witnessUtxo.asset).hex,
        ElementsValue.fromBytes(vUtxo.witnessUtxo.value).number - CHAIN_FEE,
        redeemScriptPubKey
      ),
      new CreatorOutput(
        AssetHash.fromBytes(vUtxo.witnessUtxo.asset).hex,
        CHAIN_FEE
      ),
    ],
  });

  const updater = new Updater(pset);
  updater.addInputs([vUtxo]);

  if (!vUtxo.tapLeafScript) throw new Error('vUtxo must have tapLeafScript');

  const leafHash = bip341.tapLeafHash({
    scriptHex: vUtxo.tapLeafScript.script.toString('hex'),
  });

  const preImage = updater.pset.getInputPreimage(
    0,
    Transaction.SIGHASH_DEFAULT,
    genesisBlockHash,
    leafHash
  );

  const signature = Buffer.from(
    ecc.signSchnorr(preImage, aspPrivateKey, Buffer.alloc(32))
  );
  const pubkey = Buffer.from(
    ecc.pointFromScalar(aspPrivateKey, true).subarray(1)
  );

  const psetPartialSig: BIP371SigningData = {
    genesisBlockHash,
    tapScriptSigs: [
      {
        leafHash,
        pubkey,
        signature,
      },
    ],
  };
  const signer = new Signer(pset);
  signer.addSignature(0, psetPartialSig, Pset.SchnorrSigValidator(ecc));

  return updater.pset.toBase64();
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

export function makeSendMessage(
  txID: string,
  vout: number,
  recipientScript: string,
  amount: number
): Buffer {
  const type = address.getScriptType(Buffer.from(recipientScript, 'hex'));
  if (type !== address.ScriptType.P2Tr && type !== address.ScriptType.P2Wpkh) {
    throw new Error('recipient script must be a segwit script');
  }

  const scriptBuffer = Buffer.from(recipientScript, 'hex').subarray(2); // get only witness program
  const len = 32 + 4 + scriptBuffer.length + 8;

  const buffer = Buffer.alloc(len);
  const writer = new BufferWriter(buffer, 0);

  writer.writeSlice(Buffer.from(txID, 'hex').reverse());
  writer.writeUInt32(vout);
  writer.writeSlice(scriptBuffer);
  // litttle endian 8 bytes amount
  const amuntBuffer = Buffer.alloc(8);
  amuntBuffer.writeBigUInt64LE(BigInt(amount));
  writer.writeSlice(amuntBuffer);

  return crypto.sha256(buffer);
}

const validator = Pset.SchnorrSigValidator(ecc);

export function validateSendOrder(
  sendOrder: SendOrder,
  redeemPset: Pset,
  serviceProviderPayoutScript: string,
  genesisBlockHash: Buffer
): [valid: boolean, reason?: string] {
  const vUtxoAmount = ElementsValue.fromBytes(sendOrder.coin.witnessUtxo.value);
  if (vUtxoAmount.isConfidential) return [false, 'vUtxo is confidential'];
  if (vUtxoAmount.number !== sendOrder.amount + ASP_FEE)
    return [
      false,
      `vUtxo value should be ${sendOrder.amount + ASP_FEE}, got ${
        vUtxoAmount.number
      }`,
    ];

  const forfeitTx = Transaction.fromHex(sendOrder.forfeitTx);
  if (forfeitTx.ins.length !== 1)
    return [false, 'forfeit tx should have 1 input'];

  // forfeit tx should spend output 0 of redeem tx
  if (
    Buffer.from(forfeitTx.ins[0].hash).reverse().toString('hex') !==
    redeemPset.unsignedTx().getId()
  ) {
    return [false, 'forfeit tx should spend output 0 of redeem tx'];
  }

  // forfeit tx should have 3 outputs
  if (forfeitTx.outs.length !== 3)
    return [false, 'forfeit tx should have 3 outputs'];

  // 1. the provider fee
  const providerFeeOutput = forfeitTx.outs[0];
  const value = ElementsValue.fromBytes(providerFeeOutput.value);
  if (value.isConfidential)
    return [false, 'provider fee output should not be confidential'];
  if (value.number !== ASP_FEE)
    return [false, 'provider fee output should be 100'];
  if (providerFeeOutput.script.toString('hex') !== serviceProviderPayoutScript)
    return [
      false,
      'provider fee output should be sent to the service provider',
    ];

  // 2. the recipient
  const recipientOutput = forfeitTx.outs[1];
  const valueRecipient = ElementsValue.fromBytes(recipientOutput.value);
  if (valueRecipient.isConfidential)
    return [false, 'recipient output should not be confidential'];
  if (valueRecipient.number !== sendOrder.amount - 2 * CHAIN_FEE)
    return [
      false,
      'recipient output should be ' + (sendOrder.amount - 2 * CHAIN_FEE),
    ];
  if (
    recipientOutput.script.toString('hex') !==
    address.toOutputScript(sendOrder.address).toString('hex')
  )
    return [false, 'recipient output should be sent to the recipient script'];

  // 3. the chain fee
  const chainFeeOutput = forfeitTx.outs[2];
  const valueChainFee = ElementsValue.fromBytes(chainFeeOutput.value);
  if (valueChainFee.isConfidential)
    return [false, 'chain fee output should not be confidential'];
  if (valueChainFee.number !== CHAIN_FEE)
    return [false, 'chain fee output should be ' + CHAIN_FEE];
  if (chainFeeOutput.script.length)
    return [false, 'chain fee output should be empty'];

  // the forfeit tx should be signed
  if (!forfeitTx.ins[0].witness)
    return [false, 'forfeit tx input witness should not be empty'];
  if (forfeitTx.ins[0].witness.length !== 3)
    return [
      false,
      `forfeit tx input witness should have 3 items, got ${forfeitTx.ins[0].witness.length}`,
    ];

  // TODO: check the control block
  //   const controlBlock = forfeitTx.ins[0].witness[2];
  const script = forfeitTx.ins[0].witness[1];
  const leafHash = bip341.tapLeafHash({
    scriptHex: script.toString('hex'),
  });

  const ownerSig = forfeitTx.ins[0].witness[0];
  const preimage = forfeitTx.hashForWitnessV1(
    0,
    [redeemPset.outputs[0].script],
    [
      {
        asset: AssetHash.fromBytes(redeemPset.outputs[0].asset).bytes,
        value: ElementsValue.fromNumber(redeemPset.outputs[0].value).bytes,
      },
    ],
    Transaction.SIGHASH_DEFAULT,
    genesisBlockHash,
    leafHash
  );

  const scriptStack = bscript.decompile(script);
  const checksigIndex = scriptStack.findIndex((op) => op === OPS.OP_CHECKSIG);
  if (checksigIndex === -1)
    return [false, 'redeem script should contain OP_CHECKSIG'];
  // TODO: validate timelock

  const redeemPubKey = scriptStack[checksigIndex - 1];
  if (!redeemPubKey || !Buffer.isBuffer(redeemPubKey))
    return [false, `redeemPubKey "${redeemPubKey}" is not a buffer`];

  if (!redeemPubKey || !Buffer.isBuffer(redeemPubKey))
    return [false, `redeemPubKey "${redeemPubKey}" is not a buffer`];

  try {
    if (!validator(redeemPubKey, preimage, ownerSig))
      return [false, 'ownerSig is not valid'];
  } catch (e) {
    console.error(e);
    return [false, `ownerSig is not valid: ${e}`];
  }

  // once forfeit tx is validated, we can check the send order signature
  const msg = makeSendMessage(
    sendOrder.coin.txid,
    sendOrder.coin.txIndex,
    address.toOutputScript(sendOrder.address).toString('hex'),
    sendOrder.amount
  );

  if (!validator(redeemPubKey, msg, Buffer.from(sendOrder.signature, 'hex')))
    return [false, 'sendOrder signature is not valid'];

  return [true];
}

export function makeForfeitTransaction(
  sendOrder: Pick<SendOrder, 'coin' | 'address'>,
  redeemPset: Pset,
  redeemSecretKey: Buffer,
  serviceProviderPayoutScript: Buffer,
  genesisBlockHash: Buffer
): string {
  const pset = Creator.newPset({
    outputs: [
      new CreatorOutput(
        AssetHash.fromBytes(redeemPset.outputs[0].asset).hex,
        ASP_FEE,
        serviceProviderPayoutScript
      ),
      new CreatorOutput(
        AssetHash.fromBytes(redeemPset.outputs[0].asset).hex,
        redeemPset.outputs[0].value - CHAIN_FEE - ASP_FEE,
        address.toOutputScript(sendOrder.address)
      ),
      new CreatorOutput(
        AssetHash.fromBytes(redeemPset.outputs[0].asset).hex,
        CHAIN_FEE
      ),
    ],
  });

  const updater = new Updater(pset);

  updater.addInputs([
    {
      txid: redeemPset.unsignedTx().getId(),
      txIndex: 0,
      witnessUtxo: redeemPset.unsignedTx().outs[0],
      sighashType: Transaction.SIGHASH_DEFAULT,
    },
  ]);

  // re-build the redeem tree in order to sign it
  const redeemPublicKey = Buffer.from(
    ecc.pointFromScalar(redeemSecretKey, true).subarray(1)
  );
  const leaf = makeTimelockedScriptLeaf(redeemPublicKey);
  const tree = bip341.toHashTree([leaf]);

  const [, controlBlock] = bip341
    .BIP341Factory(ecc)
    .taprootSignScriptStack(
      H_POINT,
      leaf,
      tree.hash,
      bip341.findScriptPath(tree, bip341.tapLeafHash(leaf))
    );

  const pubkey = Buffer.from(
    ecc.pointFromScalar(redeemSecretKey, true).subarray(1)
  );

  updater.addInTapLeafScript(0, {
    controlBlock,
    leafVersion: bip341.LEAF_VERSION_TAPSCRIPT,
    script: Buffer.from(leaf.scriptHex, 'hex'),
  });

  updater.addInTapInternalKey(0, H_POINT.subarray(1));

  const preimage = updater.pset.getInputPreimage(
    0,
    Transaction.SIGHASH_DEFAULT,
    genesisBlockHash,
    bip341.tapLeafHash(leaf)
  );

  const signature = Buffer.from(
    ecc.signSchnorr(preimage, redeemSecretKey, Buffer.alloc(32))
  );

  const psetPartialSig: BIP371SigningData = {
    genesisBlockHash,
    tapScriptSigs: [
      {
        leafHash: bip341.tapLeafHash(leaf),
        pubkey,
        signature,
      },
    ],
  };

  const signer = new Signer(updater.pset);
  signer.addSignature(0, psetPartialSig, validator);

  const finalizer = new Finalizer(signer.pset);
  finalizer.finalize();

  return Extractor.extract(finalizer.pset).toHex();
}

export function signSendOrderPoolPset(
  poolPset: Pset,
  sendOrder: SendOrder,
  serviceProviderSecretKey: Buffer,
  redeemPublicKey: Buffer
): Pset {
  // find vUtxo input index
  const coinTxHash = Buffer.from(sendOrder.coin.txid, 'hex').reverse();
  const vUtxoIndex = poolPset.inputs.findIndex(
    (i) =>
      i.previousTxIndex === sendOrder.coin.txIndex &&
      i.previousTxid.equals(coinTxHash)
  );

  if (vUtxoIndex === -1) {
    throw new Error('vUtxo not found');
  }

  const recipientScript = address.toOutputScript(sendOrder.address);

  // find the recipient output in pool tx
  const recipientOutputIndex = poolPset.outputs.findIndex((o) =>
    o.script.equals(recipientScript)
  );

  if (recipientOutputIndex === -1) {
    throw new Error('recipient output not found');
  }

  const serviceProviderPubKey = Buffer.from(
    ecc.pointFromScalar(serviceProviderSecretKey, true)
  );

  const { sendLeaf } = makeVirtualUtxoTaprootTree(
    serviceProviderPubKey,
    redeemPublicKey
  );

  const updater = new Updater(poolPset);
  updater.addInTapLeafScript(vUtxoIndex, sendLeaf);

  const finalizer = new Finalizer(updater.pset);

  const msg = makeSendMessage(
    sendOrder.coin.txid,
    sendOrder.coin.txIndex,
    address.toOutputScript(sendOrder.address).toString('hex'),
    sendOrder.amount
  );

  const signature = Buffer.from(
    ecc.signSchnorr(msg, serviceProviderSecretKey, Buffer.alloc(32))
  );

  finalizer.finalizeInput(vUtxoIndex, (inIndex, pset) => {
    const input = pset.inputs[inIndex];
    const controlBlock = input.tapLeafScript[0].controlBlock;
    const script = input.tapLeafScript[0].script;

    if (!controlBlock || !script) {
      throw new Error('controlBlock or script not found');
    }

    const amount = Buffer.alloc(8);
    amount.writeBigUint64LE(BigInt(sendOrder.amount));

    const witnessArgs = [
      address.toOutputScript(sendOrder.address).subarray(2), // witnessProgram
      amount,
      bscript.number.encode(recipientOutputIndex),
      signature,
      Buffer.from(sendOrder.signature, 'hex'),
    ];

    const finalScriptWitness = witnessStackToScriptWitness([
      ...witnessArgs,
      script,
      controlBlock,
    ]);

    return {
      finalScriptWitness,
    };
  });

  return finalizer.pset;
}

function makeVirtualUtxoTaprootTree(
  serviceProviderPublicKey: Buffer,
  redeemPublicKey: Buffer
): VirtualUtxoTaprootTree {
  const covenantScript = bscript.compile([
    // [outputScript, amount, outputIndex, sigASP, sigOwner]
    OPS.OP_PUSHCURRENTINPUTINDEX,
    OPS.OP_INSPECTINPUTOUTPOINT,
    // [outputScript, amount, outputIndex, sigASP, sigOwner, txid, vout, outpointFlag]
    OPS.OP_DROP, // we don't need the flag
    OPS.OP_CAT,
    // [outputScript, amount, outputIndex, sigASP, sigOwner, txid+vout]
    OPS.OP_5,
    OPS.OP_PICK,
    // [outputScript, amount, outputIndex, sigASP, sigOwner, txid+vout, outputScript]
    OPS.OP_CAT,
    // [outputScript, amount, outputIndex, sigASP, sigOwner, txid+vout+outputScript]
    OPS.OP_4,
    OPS.OP_PICK,
    OPS.OP_CAT,
    // [outputScript, amount, outputIndex, sigASP, sigOwner, txid+vout+outputScript+amount]
    OPS.OP_SHA256,
    // [outputScript, amount, outputIndex, sigASP, sigOwner, sha(txid+vout+outputScript+amount)]
    OPS.OP_DUP,
    // [outputScript, amount, outputIndex, sigASP, sigOwner, sha(msg), sha(msg)]
    OPS.OP_2,
    OPS.OP_ROLL,
    // [outputScript, amount, outputIndex, sigASP, sha(msg), sha(msg), sigOwner]
    OPS.OP_SWAP,
    redeemPublicKey.subarray(1),
    // [outputScript, amount, outputIndex, sigASP, sha(msg), sigOwner, sha(msg), aspPublicKey]
    OPS.OP_CHECKSIGFROMSTACKVERIFY,
    // [outputScript, amount, outputIndex, sigASP, sha(msg)]
    serviceProviderPublicKey.subarray(1),

    // [outputScript, amount, outputIndex, sigASP, sha(msg), redeemPublicKey]
    OPS.OP_CHECKSIGFROMSTACKVERIFY,
    // [outputscript, amount, outputIndex]
    OPS.OP_1,
    OPS.OP_ROLL,
    OPS.OP_1,
    OPS.OP_PICK,
    // [script, outputIndex, amount, outputIndex]
    OPS.OP_INSPECTOUTPUTVALUE,
    OPS.OP_1,
    OPS.OP_EQUALVERIFY,
    OPS.OP_EQUALVERIFY,
    // [outputScript, outputIndex]
    OPS.OP_INSPECTOUTPUTSCRIPTPUBKEY,
    OPS.OP_DROP,
    OPS.OP_EQUAL,
  ]);

  const redeemScript = bscript.compile([
    serviceProviderPublicKey,
    OPS.OP_CHECKSIGVERIFY,
    redeemPublicKey,
    OPS.OP_CHECKSIG,
  ]);

  const leaves: bip341.TaprootLeaf[] = [
    {
      scriptHex: redeemScript.toString('hex'),
    },
    {
      scriptHex: covenantScript.toString('hex'),
    },
  ];

  const tree = bip341.toHashTree(leaves, true);

  const redeemLeafHash = bip341.tapLeafHash({
    scriptHex: redeemScript.toString('hex'),
  });

  const refundKey = Buffer.from(
    ecc.pointAdd(serviceProviderPublicKey, redeemPublicKey)
  );

  const path = bip341.findScriptPath(tree, redeemLeafHash);

  const [, controlBlock] = bip341
    .BIP341Factory(ecc)
    .taprootSignScriptStack(refundKey, leaves[0], tree.hash, path);

  const sendLeafHash = bip341.tapLeafHash({
    scriptHex: covenantScript.toString('hex'),
  });

  const pathToSendLeaf = bip341.findScriptPath(tree, sendLeafHash);

  const [, sendControlBlock] = bip341
    .BIP341Factory(ecc)
    .taprootSignScriptStack(refundKey, leaves[1], tree.hash, pathToSendLeaf);

  return {
    redeemLeaf: {
      controlBlock,
      leafVersion: bip341.LEAF_VERSION_TAPSCRIPT,
      script: redeemScript,
    },
    sendLeaf: {
      controlBlock: sendControlBlock,
      leafVersion: bip341.LEAF_VERSION_TAPSCRIPT,
      script: covenantScript,
    },
    tree,
  };
}

/**
 * Notes:
 * A --> B
 * Alice onboard some coins to the pool
 * S locks the coins on A+S script + covenant "send"
 * S creates a redeem tx and sign it, it sends it to A. Redeem tx free the coins with a timelock to A.
 * B sends an address to A
 * A creates a SEND ORDER and signs it + a forfeit tx on redeem tx received above. It sends it to S.
 * S checks A data and signs the order. Order signed will let S to spend the output
 */
