import { LOCK_DENIES, PERMISSIONS, type Base, type Overwrite, type OverwriteTarget, type PermissionName } from './types.js';

const sorted = <T extends string>(xs: readonly T[]): T[] => [...xs].sort();

export function overwrite(
  target: OverwriteTarget,
  parts: { allow?: PermissionName[]; deny?: PermissionName[]; allowOther?: string[]; denyOther?: string[] } = {},
): Overwrite {
  return {
    target,
    allow: sorted(parts.allow ?? []),
    deny: sorted(parts.deny ?? []),
    allowOther: sorted(parts.allowOther ?? []),
    denyOther: sorted(parts.denyOther ?? []),
  };
}

/** `@everyone`'s guild permissions under each base. */
export const BASE_PERMISSIONS: Record<Base, PermissionName[]> = {
  default: sorted(PERMISSIONS),
  nosend: sorted(['ViewChannel', 'ReadMessageHistory'] as PermissionName[]),
};

/**
 * The candidate bot overwrite: View, Send and Manage Channels. §6.3 also allows Manage Roles, but a
 * non-admin bot can't grant that in an overwrite (S3's first recording), so the candidate drops it
 * and genie writes overwrites through its guild-level Manage Roles instead.
 */
export const genieOverwrite = (): Overwrite =>
  overwrite('member:genie', { allow: ['ViewChannel', 'SendMessages'], allowOther: ['ManageChannels'] });

/** §6.3's bot overwrite as accepted, with Manage Roles. Diagnostic cases only. */
export const originalGenieOverwrite = (): Overwrite =>
  overwrite('member:genie', { allow: ['ViewChannel', 'SendMessages'], allowOther: ['ManageChannels', 'ManageRoles'] });

const stafferOpen = (target: OverwriteTarget) =>
  overwrite(target, { allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'], allowOther: ['AttachFiles'] });

const stafferLocked = (target: OverwriteTarget) =>
  overwrite(target, { allow: ['ViewChannel', 'ReadMessageHistory'], deny: LOCK_DENIES, allowOther: ['AttachFiles'] });

/** §6.3's open profile. `member:other` is always a staffer; the subject is one when `subjectIsStaffer`. */
export function openProfile(subjectIsStaffer: boolean): Overwrite[] {
  return withGenie(subjectIsStaffer, genieOverwrite());
}

/** The open profile with §6.3's original bot overwrite. Diagnostic cases only. */
export function originalOpenProfile(subjectIsStaffer: boolean): Overwrite[] {
  return withGenie(subjectIsStaffer, originalGenieOverwrite());
}

function withGenie(subjectIsStaffer: boolean, genie: Overwrite): Overwrite[] {
  return [
    overwrite('everyone', { deny: ['ViewChannel'] }),
    genie,
    overwrite('role:organizer', { allow: ['ViewChannel'] }),
    ...(subjectIsStaffer ? [stafferOpen('member:subject')] : []),
    stafferOpen('member:other'),
  ];
}

/** §6.5's locked profile: explicit denies everywhere, the audience keeps View and Read History. */
export function lockedProfile(subjectIsStaffer: boolean): Overwrite[] {
  return [
    overwrite('everyone', { deny: ['ViewChannel', ...LOCK_DENIES] }),
    genieOverwrite(),
    overwrite('role:organizer', { allow: ['ViewChannel', 'ReadMessageHistory'], deny: LOCK_DENIES }),
    ...(subjectIsStaffer ? [stafferLocked('member:subject')] : []),
    stafferLocked('member:other'),
  ];
}

/** §6.3's category overwrites: deny @everyone View, allow the bot and the organizer role. */
export function categoryProfile(): Overwrite[] {
  return [overwrite('everyone', { deny: ['ViewChannel'] }), genieOverwrite(), overwrite('role:organizer', { allow: ['ViewChannel'] })];
}

export { stafferOpen };
