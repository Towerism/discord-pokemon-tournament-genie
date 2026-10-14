/**
 * The one audience model (ADR-0010): every "who may see or do this" decision, on the website and in Discord,
 * goes through this module. Pure: callers pass in what they know (membership comes from the bot, the owner and
 * the allowlist from the database).
 *
 * M1 knows the install-wide resources. Days, events, penalties and exports join with M2.
 */

/** How a website login was admitted, as `login_audit.grant` records it. */
export type Grant = 'owner' | 'organizer_role' | 'allowlist';

export interface Member {
  userId: string;
  roleIds: readonly string[];
}

export interface AccessInput {
  userId: string;
  /** The user's membership of the bound guild, or `null` when they aren't a member. */
  member: Member | null;
  ownerId: string | null;
  organizerRoleId: string | null;
  allowlist: { enabled: boolean; userIds: readonly string[] };
}

export type AccessDecision =
  | { allowed: true; grant: Grant }
  | { allowed: false; reason: 'not_in_guild' | 'no_access' };

/**
 * Who may use the website (ADR-0004): members of the bound guild only, then the owner, then organizer-role
 * holders. With the allowlist on, organizers are `owner ∪ (organizer role ∩ allowlist)`.
 */
export function decideAccess(input: AccessInput): AccessDecision {
  const { userId, member, ownerId, organizerRoleId, allowlist } = input;
  if (!member) return { allowed: false, reason: 'not_in_guild' };
  if (ownerId !== null && userId === ownerId) return { allowed: true, grant: 'owner' };

  const hasRole = organizerRoleId !== null && member.roleIds.includes(organizerRoleId);
  if (!hasRole) return { allowed: false, reason: 'no_access' };
  if (!allowlist.enabled) return { allowed: true, grant: 'organizer_role' };
  return allowlist.userIds.includes(userId)
    ? { allowed: true, grant: 'allowlist' }
    : { allowed: false, reason: 'no_access' };
}

export interface Principal {
  userId: string;
  grant: Grant;
}

export type Resource = { kind: 'website' } | { kind: 'settings' } | { kind: 'organizer_allowlist' };

/** Every M1 grant is an organizer grant; the owner alone edits the allowlist (§9). */
export function canSee(principal: Principal | null, resource: Resource): boolean {
  if (!principal) return false;
  switch (resource.kind) {
    case 'website':
    case 'settings':
      return true;
    case 'organizer_allowlist':
      return principal.grant === 'owner';
  }
}
