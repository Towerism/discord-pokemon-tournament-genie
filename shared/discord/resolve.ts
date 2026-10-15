/**
 * Effective permissions in Discord's resolution order (architecture §4.1, ADR-0012). Pure: the fake gateway and
 * the privacy audit both use it, and spike S3's recorded cases are its oracle.
 */
import type { Overwrite } from './overwrites';
import { PERMISSION_BITS, type PermissionName } from './permissions';

export const ALL_PERMISSIONS = (1n << 64n) - 1n;

export interface ResolveInput {
  guildId: string;
  guildOwnerId: string | null;
  /** Every guild role, `@everyone` (whose ID is the guild's) included. */
  roles: readonly { id: string; permissions: bigint }[];
  member: { userId: string; roleIds: readonly string[] };
  /** `null` for guild-level permissions. */
  channel: { overwrites: readonly Overwrite[] } | null;
  thread?: { type: 'public' | 'private'; archived: boolean; memberIds: readonly string[] };
}

export function effectivePermissions(input: ResolveInput): bigint {
  const { guildId, guildOwnerId, roles, member, channel, thread } = input;
  if (guildOwnerId !== null && member.userId === guildOwnerId) return ALL_PERMISSIONS;

  const held = new Set([guildId, ...member.roleIds]);
  let bits = 0n;
  for (const r of roles) if (held.has(r.id)) bits |= r.permissions;
  if (bits & PERMISSION_BITS.Administrator) return ALL_PERMISSIONS;
  if (!channel) return bits;

  const overwrites = channel.overwrites;
  const everyone = overwrites.find((o) => o.target.kind === 'everyone');
  if (everyone) bits = (bits & ~everyone.deny) | everyone.allow;

  let roleDeny = 0n;
  let roleAllow = 0n;
  for (const o of overwrites) {
    if (o.target.kind === 'role' && member.roleIds.includes(o.target.id)) {
      roleDeny |= o.deny;
      roleAllow |= o.allow;
    }
  }
  bits = (bits & ~roleDeny) | roleAllow;

  const own = overwrites.find((o) => o.target.kind === 'member' && o.target.id === member.userId);
  if (own) bits = (bits & ~own.deny) | own.allow;

  // Without View, a member has nothing else in the channel (S3, ADR-0012).
  if (!(bits & PERMISSION_BITS.ViewChannel)) return 0n;

  if (thread?.type === 'private' && !thread.memberIds.includes(member.userId) && !(bits & PERMISSION_BITS.ManageThreads)) return 0n;
  return bits;
}

export const can = (bits: bigint, name: PermissionName): boolean => (bits & PERMISSION_BITS[name]) !== 0n;
