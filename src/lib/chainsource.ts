import { crypto } from 'liquidjs-lib';
import { ElectrumWS } from 'ws-electrumx-client';

import { ChainSource, Unspent } from './poolWatcher';

const BroadcastTransaction = 'blockchain.transaction.broadcast'; // returns txid
const GetTransactionMethod = 'blockchain.transaction.get'; // returns hex string
const ListUnspentMethod = 'blockchain.scripthash.listunspent';

const MISSING_TRANSACTION = 'missingtransaction';
const MAX_FETCH_TRANSACTIONS_ATTEMPTS = 5;

export class WsElectrumChainSource implements ChainSource {
  private ws: ElectrumWS;

  constructor(url: string) {
    this.ws = new ElectrumWS(url);
  }

  listUnspents(script: string): Promise<Unspent[]> {
    const scriptHash = toScriptHash(Buffer.from(script, 'hex'));
    return this.ws.request<Unspent[]>(ListUnspentMethod, scriptHash);
  }

  async fetchTransactions(
    txids: string[]
  ): Promise<{ txID: string; hex: string }[]> {
    const requests = txids.map((txid) => ({
      method: GetTransactionMethod,
      params: [txid],
    }));
    for (let i = 0; i < MAX_FETCH_TRANSACTIONS_ATTEMPTS; i++) {
      try {
        const responses = await this.ws.batchRequest<string[]>(...requests);
        return responses.map((hex, i) => ({ txID: txids[i], hex }));
      } catch (e) {
        if (extractErrorMessage(e).includes(MISSING_TRANSACTION)) {
          console.warn('missing transaction error, retrying');
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        throw e;
      }
    }
    throw new Error('Unable to fetch transactions: ' + txids);
  }

  async broadcastTransaction(hex: string): Promise<string> {
    return this.ws.request<string>(BroadcastTransaction, hex);
  }

  async close() {
    try {
      await this.ws.close('close');
    } catch (e) {
      console.debug('error closing ws:', e);
    }
  }
}

function extractErrorMessage(
  error: unknown,
  defaultMsg = 'unknown error'
): string {
  // if is already a string, return it
  if (typeof error === 'string') return error;
  // this should be last
  if (error instanceof Error) return error.message;

  return defaultMsg;
}

function toScriptHash(script: Buffer): string {
  return crypto.sha256(script).reverse().toString('hex');
}
