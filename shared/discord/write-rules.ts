/**
 * Discord's rules for a bot without Administrator writing permission overwrites, as spike S3 recorded them
 * (ADR-0012). Pure: the fake refuses by them, and the adapter contract run uses them to tell which case setups
 * need an administrator.
 */
import { type Overwrite, targetKey } from './overwrites';
import { PERMISSION_BITS } from './permissions';

/**
 * Why the write would be refused, or `null`. `botBase` is the bot's guild permissions; `existing` the channel's
 * overwrites before the write (none for a create).
 */
export function writeRefusal(botBase: bigint, botUserId: string, overwrites: readonly Overwrite[], existing: readonly Overwrite[]): string | null {
  if (botBase & PERMISSION_BITS.Administrator) return null;
  if (overwrites.length === 0) return null;
  if (!(botBase & PERMISSION_BITS.ManageRoles)) return 'the bot lacks Manage Roles';
  for (const o of overwrites) {
    if ((o.allow | o.deny) & ~botBase) return `${targetKey(o.target)} uses permissions the bot doesn't hold`;
  }
  const grantsManageRoles = overwrites.some((o) => o.allow & PERMISSION_BITS.ManageRoles);
  const alreadyHas = existing.some((o) => o.target.kind === 'member' && o.target.id === botUserId && o.allow & PERMISSION_BITS.ManageRoles);
  if (grantsManageRoles && !alreadyHas) return 'an overwrite grants Manage Roles the channel doesn’t already give the bot';
  return null;
}
