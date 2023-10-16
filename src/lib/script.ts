import bip68 from 'bip68';
import {
  script as bscript,
  FinalizeFunc,
  Pset,
  witnessStackToScriptWitness,
} from 'liquidjs-lib';
import { BufferWriter } from 'liquidjs-lib/src/bufferutils';
import { OPS } from 'liquidjs-lib/src/ops';

import { ForfeitMessage } from './core';

const validBIP68 = (buf: Buffer): boolean => {
  try {
    bip68.decode(buf);
    return true;
  } catch {
    return false;
  }
};

export class CheckSequenceVerifyScript {
  constructor(public ownerPublicKey: Buffer, public timeoutBIP68: Buffer) {
    if (ownerPublicKey.length !== 32) {
      throw new Error(
        `Invalid owner public key expected 32 bytes got ${ownerPublicKey.length}`
      );
    }

    if (!validBIP68(timeoutBIP68)) {
      throw new Error('Invalid timeout');
    }
  }

  static decompile(buf: Buffer): CheckSequenceVerifyScript {
    const stack = bscript.decompile(buf);
    if (!stack) {
      throw new Error('Invalid script: stack is empty');
    }

    // find OP_CHECKSIGVERIFY
    const idChecksig = stack.findIndex((op) => op === OPS.OP_CHECKSIG);
    if (idChecksig === -1) {
      throw new Error('Invalid script: OP_CHECKSIG  expected');
    }
    const ownerPublicKey = stack[idChecksig - 1];

    if (
      !ownerPublicKey ||
      !Buffer.isBuffer(ownerPublicKey) ||
      ownerPublicKey.length !== 32
    ) {
      throw new Error('Invalid owner public key');
    }

    // find OP_CHECKSEQUENCEVERIFY
    const idCheckseq = stack.findIndex(
      (op) => op === OPS.OP_CHECKSEQUENCEVERIFY
    );
    if (idCheckseq === -1) {
      throw new Error('Invalid script: OP_CHECKSEQUENCEVERIFY expected');
    }
    const timeoutBIP68 = stack[idCheckseq - 1];

    if (
      !timeoutBIP68 ||
      !Buffer.isBuffer(timeoutBIP68) ||
      !validBIP68(timeoutBIP68)
    ) {
      throw new Error('Invalid timeout');
    }

    const res = new CheckSequenceVerifyScript(ownerPublicKey, timeoutBIP68);
    if (!buf.includes(res.compile())) {
      throw new Error('Invalid script');
    }
    return res;
  }

  compile(): Buffer {
    return bscript.compile([
      this.timeoutBIP68,
      OPS.OP_CHECKSEQUENCEVERIFY,
      OPS.OP_DROP,
      this.ownerPublicKey,
      OPS.OP_CHECKSIG,
    ]);
  }
}

export class FrozenReceiverScript {
  constructor(public ownerPublicKey: Buffer, public witnessProgram: Buffer) {
    if (ownerPublicKey.length !== 32) {
      throw new Error('Invalid owner public key');
    }

    if (witnessProgram.length !== 32) {
      throw new Error('Invalid receiver witness program');
    }
  }

  static decompile(buf: Buffer): FrozenReceiverScript {
    const stack = bscript.decompile(buf);
    if (!stack) {
      throw new Error('Invalid script');
    }

    // find OP_CHECKSIGVERIFY

    const idChecksig = stack.findIndex((op) => op === OPS.OP_CHECKSIGVERIFY);
    if (idChecksig === -1) {
      throw new Error('Invalid script');
    }
    const ownerPublicKey = stack[idChecksig - 1];

    if (
      !ownerPublicKey ||
      !Buffer.isBuffer(ownerPublicKey) ||
      ownerPublicKey.length !== 32
    ) {
      throw new Error('Invalid script');
    }

    // find OP_EQUAL
    const idEqual = stack.findIndex((op) => op === OPS.OP_EQUAL);
    if (idEqual === -1) {
      throw new Error('Invalid script');
    }

    const witnessProgram = stack[idEqual - 1];
    if (
      !witnessProgram ||
      !Buffer.isBuffer(witnessProgram) ||
      witnessProgram.length !== 32
    ) {
      throw new Error('Invalid script');
    }

    const res = new FrozenReceiverScript(ownerPublicKey, witnessProgram);
    if (!buf.includes(res.compile())) {
      throw new Error('Invalid script');
    }
    return res;
  }

  compile(): Buffer {
    return bscript.compile([
      // [index, vUtxoOwnerSig]
      this.ownerPublicKey,
      OPS.OP_CHECKSIGVERIFY,
      // [index]
      OPS.OP_DUP,
      OPS.OP_DUP,
      // [index, index, index]

      OPS.OP_PUSHCURRENTINPUTINDEX,
      OPS.OP_INSPECTINPUTASSET,
      OPS.OP_CAT,
      // [index, index, index, asset+assetPrefix]
      OPS.OP_SWAP,
      // [index, index, asset+assetPrefix, index]
      OPS.OP_INSPECTOUTPUTASSET,
      OPS.OP_CAT,
      // [index, index, asset+assetPrefix, asset+assetPrefix]
      OPS.OP_EQUALVERIFY,

      OPS.OP_PUSHCURRENTINPUTINDEX,
      OPS.OP_INSPECTINPUTVALUE,
      OPS.OP_CAT,
      // [index, index, value+valuePrefix]
      OPS.OP_SWAP,
      // [index, value+valuePrefix, index]
      OPS.OP_INSPECTOUTPUTVALUE,
      OPS.OP_CAT,
      OPS.OP_EQUALVERIFY,
      // [index]
      OPS.OP_INSPECTOUTPUTSCRIPTPUBKEY,
      OPS.OP_1, // should be segwit v1
      OPS.OP_EQUALVERIFY,
      this.witnessProgram,
      OPS.OP_EQUAL,
    ]);
  }

  static finalizer(outputIndex: number): FinalizeFunc {
    return (inputIndex: number, pset: Pset) => {
      const tapLeaf = getFirstTapLeafScript(pset, inputIndex);
      const sigPublicKey = FrozenReceiverScript.decompile(
        tapLeaf.script
      ).ownerPublicKey;

      // search for the signature in partial sig,
      const sig = pset.inputs[inputIndex].tapScriptSig?.find((ps) =>
        ps.pubkey.equals(sigPublicKey)
      )?.signature;

      if (!sig) {
        throw new Error('Signature not found');
      }

      const args = [
        outputIndex ? bscript.number.encode(outputIndex) : Buffer.alloc(0),
        sig,
      ];

      return {
        finalScriptWitness: witnessStackToScriptWitness(
          args.concat(tapLeaf.script).concat(tapLeaf.controlBlock)
        ),
      };
    };
  }
}

export class ForfeitScript {
  constructor(public ownerPubKey: Buffer, public providerPubKey: Buffer) {
    if (ownerPubKey.length !== 32) {
      throw new Error('Invalid owner public key');
    }

    if (providerPubKey.length !== 32) {
      throw new Error('Invalid provider public key');
    }
  }

  static decompile(buf: Buffer): ForfeitScript {
    const stack = bscript.decompile(buf);
    if (!stack) {
      throw new Error('Invalid script');
    }

    // find OP_CHECKSIGFROMSTACKVERIFY
    const first = stack.findIndex(
      (op) => op === OPS.OP_CHECKSIGFROMSTACKVERIFY
    );
    if (first === -1) {
      throw new Error('Invalid script');
    }

    const ownerPubKey = stack[first - 1];

    if (
      !ownerPubKey ||
      !Buffer.isBuffer(ownerPubKey) ||
      ownerPubKey.length !== 32
    ) {
      throw new Error('Invalid script');
    }

    const second = stack
      .slice(first + 1)
      .findIndex((op) => op === OPS.OP_CHECKSIGFROMSTACKVERIFY);
    if (second === -1) {
      throw new Error('Invalid script');
    }

    const providerPubKey = stack.slice(first + 1)[second - 1];

    if (
      !providerPubKey ||
      !Buffer.isBuffer(providerPubKey) ||
      providerPubKey.length !== 32
    ) {
      throw new Error('Invalid script');
    }

    const res = new ForfeitScript(ownerPubKey, providerPubKey);
    if (!buf.includes(res.compile())) {
      throw new Error('Invalid script');
    }
    return res;
  }

  compile(): Buffer {
    return bscript.compile([
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
      this.ownerPubKey,
      OPS.OP_CHECKSIGFROMSTACKVERIFY,
      // [aspSignature, promisedTxId, hash]
      OPS.OP_2,
      OPS.OP_ROLL,
      // [promisedTx, hash, aspSignature]
      OPS.OP_SWAP,
      // [promisedTx, aspSignature, hash]
      this.providerPubKey,
      OPS.OP_CHECKSIGFROMSTACKVERIFY,

      // [promisedTxId]
      OPS.OP_0,
      OPS.OP_INSPECTINPUTOUTPOINT,
      OPS.OP_DROP, // drop the input flag
      OPS.OP_DROP, // drop the input vout
      OPS.OP_EQUAL, // check that input 0 is the promised tx ID
    ]);
  }

  static finalizer(
    msg: ForfeitMessage,
    aspSig: Buffer,
    userSig: Buffer
  ): FinalizeFunc {
    return function (inIndex: number, pset: Pset) {
      const tapLeaf = getFirstTapLeafScript(pset, inIndex);

      const outpoint = BufferWriter.withCapacity(32 + 4);
      outpoint.writeSlice(Buffer.from(msg.vUtxoTxID, 'hex').reverse());
      outpoint.writeUInt32(msg.vUtxoIndex);

      const args = [
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
}

function getFirstTapLeafScript(pset: Pset, inputIndex: number) {
  const tapLeaf = pset.inputs[inputIndex].tapLeafScript?.at(0);
  if (!tapLeaf) {
    throw new Error('input must have tapLeafScript');
  }
  return tapLeaf;
}
