/**
 * The one audience model (ADR-0010): every "who may see or do this" decision, on the website and in Discord,
 * goes through this module. Pure: callers pass in what they know (membership comes from the bot, the owner and
 * the allowlist from the database).
 *
 * Install-wide resources, and since M2 days and their channels. Penalties and exports join with M4 and M5.
 */
import type { DesiredDay, PlanInput } from '../blueprints';

/** How a website login was admitted, as `login_audit.grant` records it. */
export type Grant = 'owner' | 'organizer_role' | 'allowlist' | 'event_head_judge';

const ORGANIZER_GRANTS: readonly Grant[] = ['owner', 'organizer_role', 'allowlist'];
export const isOrganizer = (grant: Grant): boolean => ORGANIZER_GRANTS.includes(grant);

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
  /** A day head judge of any day not purged, worked out by the caller from the day plans. */
  dayHeadJudge: boolean;
}

export type AccessDecision =
  | { allowed: true; grant: Grant }
  | { allowed: false; reason: 'not_in_guild' | 'no_access' };

/**
 * Who may use the website (ADR-0004): members of the bound guild only, then the owner, then organizer-role
 * holders. With the allowlist on, organizers are `owner ∪ (organizer role ∩ allowlist)`. Anyone else who is a day
 * head judge gets that day's pages (`event_head_judge`).
 */
export function decideAccess(input: AccessInput): AccessDecision {
  const { userId, member, ownerId, organizerRoleId, allowlist, dayHeadJudge } = input;
  if (!member) return { allowed: false, reason: 'not_in_guild' };
  if (ownerId !== null && userId === ownerId) return { allowed: true, grant: 'owner' };

  const hasRole = organizerRoleId !== null && member.roleIds.includes(organizerRoleId);
  if (hasRole && !allowlist.enabled) return { allowed: true, grant: 'organizer_role' };
  if (hasRole && allowlist.userIds.includes(userId)) return { allowed: true, grant: 'allowlist' };
  if (dayHeadJudge) return { allowed: true, grant: 'event_head_judge' };
  return { allowed: false, reason: 'no_access' };
}

export interface Principal {
  userId: string;
  grant: Grant;
  /** Holds the mapped head-judge Discord role, as last checked. */
  holdsHeadJudgeRole: boolean;
}

export type Resource =
  | { kind: 'website' | 'settings' | 'organizer_allowlist' | 'directory' | 'configuration' | 'members' | 'days' | 'day_create' }
  | { kind: 'day'; action: 'read' | 'preview' | 'sync' | 'edit' | 'open' }
  | { kind: 'channel'; blueprintKey: string; eventId: number | null };

/** What `canSee` needs of one day: its linked staff and the audience of each desired channel. */
export interface AccessPlan {
  dayId: number;
  staff: { discordUserId: string; headJudgeOf: number[] }[];
  channels: { key: string; eventId: number | null; audienceUserIds: string[] }[];
}

/** Builds the access plan from the same plan and desired channels provisioning applies. */
export function accessPlan(plan: PlanInput, desired: DesiredDay): AccessPlan {
  return {
    dayId: plan.day.id,
    staff: plan.staff
      .filter((s): s is typeof s & { discordUserId: string } => s.linkState === 'linked' && s.discordUserId !== null)
      .map((s) => ({ discordUserId: s.discordUserId, headJudgeOf: s.events.filter((e) => e.role === 'headjudge').map((e) => e.eventId) })),
    channels: desired.channels.map((c) => ({ key: c.key, eventId: c.eventId, audienceUserIds: c.audience.map((a) => a.discordUserId) })),
  };
}

/** An event head judge on the day, or a holder of the head-judge role on its staff. */
export function isDayHeadJudge(principal: Principal, plan: AccessPlan): boolean {
  const staffer = plan.staff.find((s) => s.discordUserId === principal.userId);
  return staffer !== undefined && (staffer.headJudgeOf.length > 0 || principal.holdsHeadJudgeRole);
}

/**
 * The one audience model (ADR-0010). Organizers see everything but the allowlist, which is the owner's. Anyone else
 * sees only what Discord shows them, scoped to their event: never more than the desired audience.
 */
export function canSee(principal: Principal | null, resource: Resource, plan?: AccessPlan): boolean {
  if (!principal) return false;
  if (resource.kind === 'organizer_allowlist') return principal.grant === 'owner';
  if (isOrganizer(principal.grant)) return true;
  switch (resource.kind) {
    case 'website':
      return true;
    case 'day':
      return plan !== undefined && (resource.action === 'read' || resource.action === 'preview' || resource.action === 'sync') && isDayHeadJudge(principal, plan);
    case 'channel': {
      if (!plan) return false;
      const channel = plan.channels.find((c) => c.key === resource.blueprintKey && c.eventId === resource.eventId);
      if (!channel?.audienceUserIds.includes(principal.userId)) return false;
      if (resource.eventId === null) return isDayHeadJudge(principal, plan);
      return plan.staff.some((s) => s.discordUserId === principal.userId && s.headJudgeOf.includes(resource.eventId!));
    }
    default:
      return false;
  }
}
