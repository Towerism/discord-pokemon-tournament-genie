import type { Member } from '../../../shared/access/access';
import { PERMISSION_BITS, missingPermissions } from '../../../shared/discord/permissions';
import type { ApplicationInfo, GuildInfo } from '../discord/port';

export type CheckId =
  | 'token_valid'
  | 'client_id_matches'
  | 'public_bot_off'
  | 'intent_guild_members'
  | 'intent_message_content'
  | 'bot_in_guild'
  | 'permissions_present'
  | 'owner_bound'
  | 'owner_in_guild'
  | 'roles_mapped'
  | 'bot_role_above_mapped_roles';

export interface Check {
  id: CheckId;
  ok: boolean;
  detail?: string | string[];
}

export type Warning =
  | { id: 'bot_has_administrator' }
  | { id: 'bot_in_other_guilds'; guilds: { id: string; name: string }[] };

export interface Checks {
  checks: Check[];
  warnings: Warning[];
}

type Unavailable = 'unavailable';

/** What the wizard knows: the live Discord state (read with the stored token) and the stored progress. */
export interface CheckInput {
  /** `null` until a token is stored. */
  application: ApplicationInfo | 'invalid_token' | Unavailable | null;
  clientId: string | null;
  guilds: { id: string; name: string }[] | Unavailable | null;
  guildId: string | null;
  /** The chosen guild as the bot sees it; `null` when the bot isn't in it (or no guild is chosen). */
  guild: GuildInfo | Unavailable | null;
  ownerId: string | null;
  ownerMember: Member | Unavailable | null;
  organizerRoleId: string | null;
  headJudgeRoleId: string | null;
}

const NOT_YET = 'not_yet';
const UNAVAILABLE = 'discord_unavailable';
const MEMBERS_INTENT = (1 << 14) | (1 << 15);
const CONTENT_INTENT = (1 << 18) | (1 << 19);

/**
 * The setup wizard's checks (architecture §6.1). Pure: the same input always gives the same checks, so
 * `/check` and `/finish` agree. A check that can't be decided yet is `not_yet`.
 */
export function computeChecks(input: CheckInput): Checks {
  const checks: Check[] = [];
  const add = (id: CheckId, ok: boolean, detail?: string | string[]) =>
    checks.push(detail === undefined ? { id, ok } : { id, ok, detail });
  const pending = (id: CheckId, detail: string) => add(id, false, detail);

  // The application: token, client ID, Public Bot, intents.
  const app = input.application;
  if (app === null || app === 'invalid_token' || app === 'unavailable') {
    const detail = app === null ? NOT_YET : app === 'invalid_token' ? 'invalid_token' : UNAVAILABLE;
    add('token_valid', false, detail);
    const rest = app === 'invalid_token' ? NOT_YET : detail;
    for (const id of ['client_id_matches', 'public_bot_off', 'intent_guild_members', 'intent_message_content'] as const) {
      pending(id, rest);
    }
  } else {
    add('token_valid', true);
    add('client_id_matches', app.id === input.clientId);
    add('public_bot_off', !app.botPublic);
    add('intent_guild_members', (app.flags & MEMBERS_INTENT) !== 0);
    add('intent_message_content', (app.flags & CONTENT_INTENT) !== 0);
  }

  // The guild: membership, permissions.
  const guild = input.guildId === null ? null : input.guild;
  const guildPending = input.guildId === null ? NOT_YET : guild === 'unavailable' ? UNAVAILABLE : null;
  if (guildPending) {
    pending('bot_in_guild', guildPending);
    pending('permissions_present', guildPending);
  } else if (guild === null || guild === 'unavailable') {
    add('bot_in_guild', false, 'bot_not_in_guild');
    pending('permissions_present', NOT_YET);
  } else {
    add('bot_in_guild', true);
    const missing = missingPermissions(guild.botPermissions);
    if (missing.length) add('permissions_present', false, missing);
    else add('permissions_present', true);
  }

  // The owner.
  if (input.ownerId === null) {
    pending('owner_bound', NOT_YET);
    pending('owner_in_guild', NOT_YET);
  } else {
    add('owner_bound', true);
    const member = input.ownerMember;
    if (member === 'unavailable') pending('owner_in_guild', UNAVAILABLE);
    else if (member === null) add('owner_in_guild', false, 'owner_not_in_guild');
    else add('owner_in_guild', true);
  }

  // The mapped roles.
  const mapped = [input.organizerRoleId, input.headJudgeRoleId];
  const live = guild !== null && guild !== 'unavailable' ? guild : null;
  if (guildPending) {
    pending('roles_mapped', guildPending);
    pending('bot_role_above_mapped_roles', guildPending);
  } else if (!live || mapped.some((id) => id === null)) {
    pending('roles_mapped', NOT_YET);
    pending('bot_role_above_mapped_roles', NOT_YET);
  } else {
    const roles = (mapped as string[]).map((id) => ({ id, role: live.roles.find((r) => r.id === id) }));
    const gone = [...new Set(roles.filter((r) => !r.role).map((r) => r.id))];
    if (gone.length) {
      add('roles_mapped', false, gone);
      pending('bot_role_above_mapped_roles', NOT_YET);
    } else {
      add('roles_mapped', true);
      const highest = Math.max(...roles.map((r) => r.role!.position));
      add('bot_role_above_mapped_roles', live.botHighestRolePosition > highest);
    }
  }

  const warnings: Warning[] = [];
  if (live && (live.botPermissions & PERMISSION_BITS.Administrator) !== 0n) warnings.push({ id: 'bot_has_administrator' });
  if (input.guildId !== null && Array.isArray(input.guilds)) {
    const others = input.guilds.filter((g) => g.id !== input.guildId);
    if (others.length) warnings.push({ id: 'bot_in_other_guilds', guilds: others });
  }
  return { checks, warnings };
}

export const allPassed = (result: Checks): boolean => result.checks.every((c) => c.ok);
