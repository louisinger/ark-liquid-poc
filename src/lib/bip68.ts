const SEQUENCE_LOCKTIME_MASK = 0x0000ffff;
const SEQUENCE_LOCKTIME_TYPE_FLAG = 1 << 22;
const SEQUENCE_LOCKTIME_GRANULARITY = 9;
const SECONDS_MOD = 1 << SEQUENCE_LOCKTIME_GRANULARITY;
const SECONDS_MAX = SEQUENCE_LOCKTIME_MASK << SEQUENCE_LOCKTIME_GRANULARITY;

export function bip68(seconds: number): Buffer {
  if (!Number.isFinite(seconds)) throw new Error('Invalid seconds');
  if (seconds > SECONDS_MAX)
    throw new Error('seconds too large, max is ' + SECONDS_MAX);
  if (seconds % SECONDS_MOD !== 0)
    throw new Error('seconds must be a multiple of ' + SECONDS_MOD);

  const asNumber =
    SEQUENCE_LOCKTIME_TYPE_FLAG | (seconds >> SEQUENCE_LOCKTIME_GRANULARITY);
  return Buffer.from(asNumber.toString(16), 'hex').reverse();
}
