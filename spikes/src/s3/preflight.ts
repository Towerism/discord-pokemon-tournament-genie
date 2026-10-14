/** Architecture §4.1 as accepted: the permissions Genie's invite URL requests. */
export const ARCHITECTURE_INVITE_PERMISSIONS = [
  'ViewChannel',
  'ManageChannels',
  'ManageRoles',
  'ManageThreads',
  'SendMessages',
  'EmbedLinks',
  'AttachFiles',
  'ReadMessageHistory',
  'UseApplicationCommands',
] as const;

/**
 * The candidate invite set S3 records against: §4.1 plus the four permissions the lock denies that
 * §4.1 doesn't grant. Without a Manage Roles overwrite, a bot can allow or deny only permissions it
 * holds, and under a no-send `@everyone` base genie holds these only through its role.
 */
export const INVITE_PERMISSIONS = [
  ...ARCHITECTURE_INVITE_PERMISSIONS,
  'SendMessagesInThreads',
  'CreatePublicThreads',
  'CreatePrivateThreads',
  'AddReactions',
] as const;

export type GenieRoleCheck =
  | { ok: true }
  | { ok: false; reason: 'genie_permissions_mismatch'; missing: string[]; extra: string[]; administrator: boolean };

/** Checks genie's managed role only; the `@everyone` base is a case variable and isn't compared. */
export function checkGenieRole(rolePermissions: string[], anyRoleGrantsAdministrator: boolean): GenieRoleCheck {
  const want = new Set<string>(INVITE_PERMISSIONS);
  const have = new Set(rolePermissions);
  const missing = [...want].filter((p) => !have.has(p)).sort();
  const extra = [...have].filter((p) => !want.has(p)).sort();
  if (missing.length === 0 && extra.length === 0 && !anyRoleGrantsAdministrator) return { ok: true };
  return { ok: false, reason: 'genie_permissions_mismatch', missing, extra, administrator: anyRoleGrantsAdministrator };
}

export type RoleOrder = { arranger: number; arrangerAdmin: boolean; genie: number; spikeRoles: number[]; probes: number[] };

/** arranger > genie > every `spike-` role > the probes, and the arranger is an Administrator. */
export function checkRoleOrder(o: RoleOrder): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!o.arrangerAdmin) problems.push('arranger lacks Administrator');
  if (!(o.arranger > o.genie)) problems.push('arranger must be above genie');
  if (o.spikeRoles.some((p) => p >= o.genie)) problems.push('genie must be above every spike- role');
  const lowestSpike = Math.min(...o.spikeRoles, o.genie);
  if (o.probes.some((p) => p >= lowestSpike)) problems.push('every spike- role must be above the probes');
  return { ok: problems.length === 0, problems };
}
