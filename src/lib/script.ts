import { script } from 'liquidjs-lib';
import { OPS } from 'liquidjs-lib/src/ops';

export function makeTimelockedScriptLeaf(pubKey: Buffer, timeoutBIP68: Buffer) {
  const timelockedScript = script.compile([
    timeoutBIP68,
    OPS.OP_CHECKSEQUENCEVERIFY,
    OPS.OP_DROP,
    pubKey,
    OPS.OP_CHECKSIG,
  ]);

  return {
    scriptHex: timelockedScript.toString('hex'),
  };
}
