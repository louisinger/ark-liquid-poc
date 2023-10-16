import {
  bip341,
  CreatorOutput,
  Pset,
  TapInternalKey,
  TapLeafScript,
  UpdaterInput,
  UpdaterOutput,
} from 'liquidjs-lib';

export type VirtualUtxoTaprootTree = {
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

export type ExtendedVirtualUtxo = {
  vUtxo: VirtualUtxo;
  redeemTree: RedeemTaprootTree;
  vUtxoTree: VirtualUtxoTaprootTree;
};

// onchain --> vUtxo
export type LiftArgs = {
  change?: CreatorOutput;
  coins: UpdaterInput[];
  vUtxoPublicKey: Buffer;
};

// vUtxo --> vUtxo
export type VirtualTransfer = {
  vUtxo: VirtualUtxo;
  redeemLeaf: TapLeafScript;
  toPublicKey: Buffer;
  amount?: number;
};

export type ForfeitMessage = {
  vUtxoTxID: string;
  vUtxoIndex: number;
  promisedPoolTxID: string; // promised by the ASP while sending vUtxo
};

export interface Wallet {
  getPublicKey(): Buffer;
  getChangeScriptPubKey(): Buffer;
  coinSelect(
    amount: number,
    asset: string
  ): Promise<{ coins: UpdaterInput[]; change?: UpdaterOutput }>;
  sign(pset: Pset): Pset;
  signSchnorr(msg: Buffer): Buffer;
}

export type UnsignedPoolTransaction = {
  unsignedPoolPset: string; // the pool pset without the signatures
  vUtxo: VirtualUtxo;
  leaves: Map<string, Pick<ExtendedVirtualUtxo, 'vUtxoTree' | 'redeemTree'>>;
  connectors: Array<number>;
};
