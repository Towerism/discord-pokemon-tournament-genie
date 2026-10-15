import { DAY_MS } from './retention';

const HOUR_MS = 3_600_000;
export const DEFAULT_PURGE_GRACE_MS = 7 * DAY_MS;
const MIN = HOUR_MS;
const MAX = 90 * DAY_MS;

/**
 * `GENIE_PURGE_GRACE` (§6.5 step 4): `<n>h` or `<n>d`, 1 hour to 90 days, default 7 days. Anything else throws, so a
 * typo stops the boot instead of purging early or never.
 */
export function parsePurgeGrace(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_PURGE_GRACE_MS;
  const match = /^([1-9]\d{0,4})([hd])$/.exec(value);
  const ms = match ? Number(match[1]) * (match[2] === 'd' ? DAY_MS : HOUR_MS) : NaN;
  if (!(ms >= MIN && ms <= MAX)) {
    throw new Error(`GENIE_PURGE_GRACE must be a number of hours or days from 1h to 90d, like 7d or 36h (got "${value}").`);
  }
  return ms;
}
