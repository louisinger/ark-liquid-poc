import { script } from 'liquidjs-lib';
import { OPS } from 'liquidjs-lib/src/ops';

export function makeTimelockedScriptLeaf(pubKey: Buffer, timeoutBIP68: Buffer) {
  const timelockedScript = script.compile([
    timeoutBIP68,
    OPS.OP_CHECKSEQUENCEVERIFY,
    pubKey,
    OPS.OP_CHECKSIG,
  ]);

  return {
    scriptHex: timelockedScript.toString('hex'),
  };
}
