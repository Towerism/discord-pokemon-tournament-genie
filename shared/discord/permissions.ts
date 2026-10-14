/**
 * Discord permission bits Genie uses, by discord.js's flag names. Plain bigints so that shared code and the
 * setup checks don't import discord.js (only the adapter may, architecture §3).
 */
export const PERMISSION_BITS = {
  Administrator: 1n << 3n,
  ManageChannels: 1n << 4n,
  AddReactions: 1n << 6n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  MentionEveryone: 1n << 17n,
  ReadMessageHistory: 1n << 16n,
  ManageRoles: 1n << 28n,
  UseApplicationCommands: 1n << 31n,
  ManageThreads: 1n << 34n,
  CreatePublicThreads: 1n << 35n,
  CreatePrivateThreads: 1n << 36n,
  SendMessagesInThreads: 1n << 38n,
} as const;

export type PermissionName = keyof typeof PERMISSION_BITS;

const isName = (name: string): name is PermissionName => Object.hasOwn(PERMISSION_BITS, name);

/** Permission names to bits. An unknown name throws, so a typo can't silently grant nothing. */
export function bitsOf(names: readonly string[]): bigint {
  let bits = 0n;
  for (const name of names) {
    if (!isName(name)) throw new Error(`Unknown permission: ${name}`);
    bits |= PERMISSION_BITS[name];
  }
  return bits;
}

/** The named permissions set in `bits`, in declaration order. */
export function namesOf(bits: bigint): PermissionName[] {
  return (Object.keys(PERMISSION_BITS) as PermissionName[]).filter((name) => (bits & PERMISSION_BITS[name]) !== 0n);
}

/**
 * What the invite URL requests and the setup wizard checks (§4.1): the original nine plus the four the lock
 * denies, because a bot without Administrator can only allow or deny what it holds (ADR-0012).
 */
export const INVITE_PERMISSIONS = [
  'ViewChannel',
  'ManageChannels',
  'ManageRoles',
  'ManageThreads',
  'SendMessages',
  'EmbedLinks',
  'AttachFiles',
  'ReadMessageHistory',
  'UseApplicationCommands',
  'SendMessagesInThreads',
  'CreatePublicThreads',
  'CreatePrivateThreads',
  'AddReactions',
] as const satisfies readonly PermissionName[];

const INVITE_BITS = INVITE_PERMISSIONS.reduce((sum, name) => sum | PERMISSION_BITS[name], 0n);

export function inviteUrl(clientId: string): string {
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', 'bot applications.commands');
  url.searchParams.set('permissions', INVITE_BITS.toString());
  return url.toString();
}

/** The invite permissions a set of guild permission bits lacks. Administrator holds them all. */
export function missingPermissions(held: bigint): PermissionName[] {
  if (held & PERMISSION_BITS.Administrator) return [];
  return INVITE_PERMISSIONS.filter((name) => (held & PERMISSION_BITS[name]) === 0n);
}
