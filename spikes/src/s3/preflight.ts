/** Architecture §4.1: exactly the permissions Genie's invite URL requests. */
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

/** arranger > genie > every `spike-` role > the probes, and the arranger is an Administrator (FR-16). */
export function checkRoleOrder(o: RoleOrder): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!o.arrangerAdmin) problems.push('arranger lacks Administrator');
  if (!(o.arranger > o.genie)) problems.push('arranger must be above genie');
  if (o.spikeRoles.some((p) => p >= o.genie)) problems.push('genie must be above every spike- role');
  const lowestSpike = Math.min(...o.spikeRoles, o.genie);
  if (o.probes.some((p) => p >= lowestSpike)) problems.push('every spike- role must be above the probes');
  return { ok: problems.length === 0, problems };
}
