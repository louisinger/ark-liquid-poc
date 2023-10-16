import { UpdaterInput } from 'liquidjs-lib';

import { VirtualUtxo } from './core';

type Outpoint = {
  txID: string;
  index: number;
};

type ArkPublicKey = Buffer;

export interface ArkWallet {
  getRedeemedUtxos(): Promise<{ coin: UpdaterInput; freeAt?: number }[]>;
  getVirtualUtxos(): Promise<VirtualUtxo[]>;
  getNextPublicKey(): Promise<ArkPublicKey>;
  lift(
    coins: Outpoint[],
    signPset: (pset: string) => Promise<string> // should sign all "coins" inputs in the pset
  ): Promise<void>;
  sendVirtualUtxos(amount: number, to: ArkPublicKey): Promise<void>;
  sendFreeUtxos(
    amount: number,
    address: string,
    changeAddress?: string
  ): Promise<{ toBroadcastTx: string; change: number }>;
}
