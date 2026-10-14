const DISCORD_EPOCH_MS = 1420070400000n;

/** Milliseconds since the Unix epoch encoded in a Discord snowflake. */
export function snowflakeMs(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
}

export type RandomBytes = (n: number) => Uint8Array;

/** `YYYYMMDDHHmmss-xxxx` (UTC); the dash keeps it from ever looking like a snowflake. */
export function newRunId(at: Date, random: RandomBytes): string {
  const stamp = at.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const hex = Array.from(random(2), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${stamp}-${hex}`;
}
