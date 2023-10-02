/* eslint-disable @typescript-eslint/no-explicit-any */
import axios from 'axios';
import { ECPairInterface } from 'ecpair';
import {
  BIP174SigningData,
  bip341,
  BIP371SigningData,
  ElementsValue,
  networks,
  payments,
  Pset,
  script,
  Signer,
  Transaction,
  UpdaterInput,
  UpdaterOutput,
} from 'liquidjs-lib';
import * as ecc from 'tiny-secp256k1';

import { Wallet } from './core';

const APIURL = process.env.APIURL || 'http://localhost:3001';
export const TESTNET_APIURL = 'https://blockstream.info/liquidtestnet/api';

export async function faucet(address: string): Promise<any> {
  try {
    const resp = await axios.post(`${APIURL}/faucet`, { address });
    if (resp.status !== 200) {
      throw new Error('Invalid address');
    }
    const { txId } = resp.data;

    sleep(1000);
    let rr = { data: [] };
    const filter = (): any => rr.data.filter((x: any) => x.txid === txId);
    while (!rr.data.length || !filter().length) {
      sleep(1000);
      rr = await axios.get(`${APIURL}/address/${address}/utxo`);
    }

    return filter()[0];
  } catch (e) {
    const err = e as any;
    const errMsg =
      err.response && err.response.data ? err.response.data : err.request.data;
    console.error(errMsg);
    throw new Error(errMsg);
  }
}

export async function mint(address: string, quantity: number): Promise<any> {
  try {
    const resp = await axios.post(`${APIURL}/mint`, { address, quantity });
    if (resp.status !== 200) {
      throw new Error('Invalid request');
    }
    const { txId, asset } = resp.data;
    sleep(1000);
    let rr = { data: [] };
    const filter = (): any => rr.data.filter((x: any) => x.txid === txId);
    while (!rr.data.length || !filter().length) {
      sleep(1000);
      rr = await axios.get(`${APIURL}/address/${address}/utxo`);
    }

    return { asset, txid: filter()[0].txid, index: filter()[0].vout };
  } catch (e) {
    const err = e as any;
    const errMsg =
      err.response && err.response.data ? err.response.data : err.request.data;
    console.error(errMsg);
    throw new Error(errMsg);
  }
}

export async function fetchTx(txId: string): Promise<string> {
  try {
    const resp = await axios.get(`${APIURL}/tx/${txId}/hex`);
    return resp.data;
  } catch (e) {
    const err = e as any;
    const errMsg =
      err.response && err.response.data ? err.response.data : err.request.data;
    console.error(errMsg);
    throw new Error(errMsg);
  }
}

export function signTransaction(
  pset: Pset,
  signers: ECPairInterface[][]
): Pset {
  const signer = new Signer(pset);

  signers.forEach((keyPairs, i) => {
    const input = pset.inputs[i];
    const isTaproot = input.tapLeafScript && input.tapLeafScript.length > 0;
    if (isTaproot && input.tapLeafScript.length > 1)
      throw new Error('Must be 1 tapLeafScript');
    const leaf = isTaproot
      ? bip341.tapLeafHash({
          scriptHex: input.tapLeafScript.at(0).script.toString('hex'),
        })
      : undefined;
    const genesisBlockHash = isTaproot
      ? networks.regtest.genesisBlockHash
      : undefined;

    const preimage = pset.getInputPreimage(
      i,
      isTaproot
        ? Transaction.SIGHASH_DEFAULT
        : input.sighashType ?? Transaction.SIGHASH_ALL,
      genesisBlockHash,
      leaf
    );
    keyPairs.forEach((kp) => {
      if (isTaproot) {
        const partialSig: BIP371SigningData = {
          tapScriptSigs: [
            {
              leafHash: leaf,
              pubkey: kp.publicKey.subarray(1),
              signature: Buffer.from(
                ecc.signSchnorr(preimage, kp.privateKey, Buffer.alloc(32))
              ),
            },
          ],
          genesisBlockHash,
        };
        signer.addSignature(i, partialSig, Pset.SchnorrSigValidator(ecc));
        return;
      }

      const partialSig: BIP174SigningData = {
        partialSig: {
          pubkey: kp.publicKey,
          signature: script.signature.encode(
            kp.sign(preimage),
            input.sighashType ?? Transaction.SIGHASH_ALL
          ),
        },
      };
      signer.addSignature(i, partialSig, Pset.ECDSASigValidator(ecc));
    });
  });

  return signer.pset;
}

export async function broadcast(
  txHex: string,
  verbose = true,
  api: string = APIURL
): Promise<string> {
  try {
    const resp = await axios.get(`${api}/broadcast?tx=${txHex}`);
    return resp.data;
  } catch (e) {
    const err = e as any;
    const errMsg =
      err.response && err.response.data ? err.response.data : err.request.data;
    if (verbose) console.error(errMsg);
    throw new Error(errMsg);
  }
}

function sleep(ms: number): Promise<any> {
  return new Promise((res: any): any => setTimeout(res, ms));
}

export class TestWallet implements Wallet {
  private p2wpkh: payments.Payment;
  private outpoints: { txid: string; vout: number }[] = [];

  constructor(private keys: ECPairInterface) {
    this.p2wpkh = payments.p2wpkh({
      pubkey: this.keys.publicKey,
      network: networks.regtest,
    });
  }

  getPublicKey(): Buffer {
    return this.keys.publicKey;
  }

  async coinSelect(
    amount: number,
    asset: string
  ): Promise<{ coins: UpdaterInput[]; change?: UpdaterOutput }> {
    const { txid, vout } = await faucet(this.p2wpkh.address);
    this.outpoints.push({ txid, vout });
    const txHex = await fetchTx(txid);
    const transaction = Transaction.fromHex(txHex);
    const witnessUtxo = transaction.outs[vout];

    const utxo: UpdaterInput = {
      txid,
      txIndex: vout,
      witnessUtxo,
      sighashType: Transaction.SIGHASH_ALL,
    };

    const utxoAmount = ElementsValue.fromBytes(witnessUtxo.value).number;
    const changeAmount = utxoAmount - amount;

    if (changeAmount <= 0) {
      return {
        coins: [utxo],
      };
    }

    const changeOutput: UpdaterOutput = {
      amount: changeAmount,
      asset,
      script: this.p2wpkh.output,
    };

    return {
      coins: [utxo],
      change: changeOutput,
    };
  }

  sign(pset: Pset): Pset {
    const signers = [];
    for (const input of pset.inputs) {
      const inputID = Buffer.from(input.previousTxid).reverse().toString('hex');

      if (
        this.outpoints.find(
          (o) => o.txid === inputID && o.vout === input.previousTxIndex
        )
      ) {
        signers.push([this.keys]);
      } else {
        signers.push([]);
      }
    }

    return signTransaction(pset, signers);
  }

  // below methods are test helpers

  getAddressOutputScript(): Buffer {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.p2wpkh.output!;
  }

  addOutpointToSignWithKey(txid: string, vout: number): void {
    this.outpoints.push({ txid, vout });
  }
}
