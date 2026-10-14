/**
 * The privacy audit (§6.3, ADR-0005): after every apply, who can view each channel, by Discord's resolution order,
 * compared with its desired audience. Administrators, the guild owner and organizer-role holders see everything
 * whatever Genie does, so they are counted, not compared. Any other difference fails the job. Pure.
 */
import { PERMISSION_BITS } from '../../../shared/discord/permissions';
import { effectivePermissions } from '../../../shared/discord/resolve';
import type { ChannelState } from '../discord/port';

export interface AuditInput {
  guild: {
    guildId: string;
    ownerId: string;
    roles: { id: string; permissions: bigint }[];
    members: { userId: string; roleIds: string[] }[];
  };
  botUserId: string;
  organizerRoleId: string;
  /** The day's category as read back; its desired audience is empty (no member overwrites, FR-28). */
  category: ChannelState;
  channels: { key: string; eventId: number | null; state: ChannelState; audienceUserIds: string[] }[];
  orphans: ChannelState[];
}

export interface AuditFailure {
  key: string;
  eventId: number | null;
  channelId: string;
  name: string;
  extra: string[];
  missing: string[];
}

export interface AuditResult {
  failures: AuditFailure[];
  /** Distinct members across the day's channels; an administrator who is also an organizer counts as an administrator. */
  alsoVisible: { administrators: number; organizers: number };
  orphanViewers: { channelId: string; name: string; users: string[] }[];
}

export function privacyAudit(input: AuditInput): AuditResult {
  const { guild, botUserId, organizerRoleId } = input;
  const administrators = new Set<string>();
  const organizers = new Set<string>();
  const ordinary: { userId: string; roleIds: string[] }[] = [];
  for (const m of guild.members) {
    if (m.userId === botUserId) continue;
    const guildBits = effectivePermissions({ guildId: guild.guildId, guildOwnerId: guild.ownerId, roles: guild.roles, member: m, channel: null });
    if (guildBits & PERMISSION_BITS.Administrator) administrators.add(m.userId);
    else if (m.roleIds.includes(organizerRoleId)) organizers.add(m.userId);
    else ordinary.push(m);
  }
  const memberIds = new Set(guild.members.map((m) => m.userId));
  const viewers = (state: ChannelState) =>
    ordinary
      .filter((m) => effectivePermissions({ guildId: guild.guildId, guildOwnerId: guild.ownerId, roles: guild.roles, member: m, channel: { overwrites: state.overwrites } }) & PERMISSION_BITS.ViewChannel)
      .map((m) => m.userId)
      .sort();

  const failures: AuditFailure[] = [];
  const check = (key: string, eventId: number | null, state: ChannelState, audience: string[]) => {
    const want = new Set(audience.filter((u) => memberIds.has(u) && !administrators.has(u) && !organizers.has(u)));
    const got = viewers(state);
    const extra = got.filter((u) => !want.has(u));
    const missing = [...want].filter((u) => !got.includes(u)).sort();
    if (extra.length || missing.length) failures.push({ key, eventId, channelId: state.id, name: state.name, extra, missing });
  };
  check('category', null, input.category, []);
  for (const c of input.channels) check(c.key, c.eventId, c.state, c.audienceUserIds);

  return {
    failures,
    alsoVisible: { administrators: administrators.size, organizers: organizers.size },
    orphanViewers: input.orphans.map((o) => ({ channelId: o.id, name: o.name, users: viewers(o) })).filter((o) => o.users.length > 0),
  };
}
