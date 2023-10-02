import {
  bip341,
  Pset,
  TapInternalKey,
  TapLeafScript,
  UpdaterInput,
  UpdaterOutput,
} from 'liquidjs-lib';

export type VirtualUtxoTaprootTree = {
  tree: bip341.HashTree;
  redeemLeaf: TapLeafScript;
  claimLeaf: TapLeafScript; // claim by ASP after CLAIM_TIMEOUT
};

export type RedeemTaprootTree = {
  tree: bip341.HashTree;
  forfeitLeaf: TapLeafScript; // forfeit by user + ASP with the promised pool txID
  claimLeaf: TapLeafScript; // claim by user after CLAIM_TIMEOUT
};

export type VirtualUtxo = UpdaterInput & {
  tapInternalKey: TapInternalKey;
  witnessUtxo: UpdaterInput['witnessUtxo'];
};

// onchain --> vUtxo
export type OnboardOrder = {
  coins: UpdaterInput[];
  vUtxoPublicKey: Buffer;
};

// vUtxo --> vUtxo
export type TransferOrder = {
  vUtxo: VirtualUtxo;
  toPublicKey: Buffer;
};

export type ForfeitMessage = {
  vUtxoTxID: string;
  vUtxoIndex: number;
  promisedPoolTxID: string; // promised by the ASP while sending vUtxo
};

export interface Wallet {
  getPublicKey(): Buffer;
  coinSelect(
    amount: number,
    asset: string
  ): Promise<{ coins: UpdaterInput[]; change?: UpdaterOutput }>;
  sign(pset: Pset): Pset;
}

export type UnsignedPoolTransaction = {
  unsignedPoolPset: string; // the pool pset without the signatures
  vUtxos: Map<
    string,
    {
      vUtxo: VirtualUtxo;
      vUtxoTree: VirtualUtxoTaprootTree;
      redeemTree: RedeemTaprootTree;
    }
  >;
  connectors: Array<number>;
};
