/**
 * The close-out lock (§6.5, ADR-0007): explicit denies, because members keep Send from their guild base permissions
 * and leaving it out of an allow list removes nothing (§4.1). Pure: the lock job, its idempotence check and the
 * property tests all use it.
 */
import { type Overwrite, overwritesEqual } from './overwrites';
import { PERMISSION_BITS as P } from './permissions';

/** What nobody but the bot may do in a locked channel or its threads. */
export const LOCK_SET = P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads | P.AddReactions;

/**
 * Every overwrite but the bot's own loses the lock set from its allows and denies it; `@everyone` also denies View
 * (and is added when absent). Nothing else changes, so the audience keeps View and Read Message History.
 */
export function lockedOverwrites(overwrites: readonly Overwrite[], botUserId: string): Overwrite[] {
  const locked = overwrites.map((o): Overwrite => {
    if (o.target.kind === 'member' && o.target.id === botUserId) return { target: { ...o.target }, allow: o.allow, deny: o.deny };
    const deny = o.target.kind === 'everyone' ? LOCK_SET | P.ViewChannel : LOCK_SET;
    return { target: { ...o.target }, allow: o.allow & ~deny, deny: o.deny | deny };
  });
  if (!locked.some((o) => o.target.kind === 'everyone')) locked.push({ target: { kind: 'everyone' }, allow: 0n, deny: LOCK_SET | P.ViewChannel });
  return locked;
}

/** A channel already carries the lock: locking what it holds would change nothing (the relock case, #9). */
export function isLocked(overwrites: readonly Overwrite[], botUserId: string): boolean {
  return overwrites.length > 0 && overwritesEqual(lockedOverwrites(overwrites, botUserId), overwrites);
}
