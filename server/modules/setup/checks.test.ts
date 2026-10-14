import { describe, expect, it } from 'vitest';
import { INVITE_PERMISSIONS, PERMISSION_BITS } from '../../../shared/discord/permissions';
import type { ApplicationInfo, GuildInfo } from '../discord/port';
import { type CheckInput, computeChecks } from './checks';

const CLIENT = '300000000000000001';
const GUILD = '400000000000000001';
const OWNER = '100000000000000001';
const ORG_ROLE = '200000000000000001';
const HJ_ROLE = '200000000000000002';
const ALL = INVITE_PERMISSIONS.reduce((sum, name) => sum | PERMISSION_BITS[name], 0n);
const INTENTS = (1 << 14) | (1 << 18);

const app = (over: Partial<ApplicationInfo> = {}): ApplicationInfo => ({
  id: CLIENT,
  botPublic: false,
  flags: INTENTS,
  ...over,
});

const guild = (over: Partial<GuildInfo> = {}): GuildInfo => ({
  id: GUILD,
  name: 'Store',
  roles: [
    { id: ORG_ROLE, name: 'Organizer', position: 3, managed: false, permissions: 0n },
    { id: HJ_ROLE, name: 'Head judge', position: 2, managed: false, permissions: 0n },
  ],
  botRoleIds: ['bot-role'],
  botHighestRolePosition: 5,
  botPermissions: ALL,
  ...over,
});

/** Everything in place: every check passes. */
const ready = (over: Partial<CheckInput> = {}): CheckInput => ({
  application: app(),
  clientId: CLIENT,
  guilds: [{ id: GUILD, name: 'Store' }],
  guildId: GUILD,
  guild: guild(),
  ownerId: OWNER,
  ownerMember: { userId: OWNER, roleIds: [] },
  organizerRoleId: ORG_ROLE,
  headJudgeRoleId: HJ_ROLE,
  ...over,
});

const check = (input: CheckInput, id: string) => computeChecks(input).checks.find((c) => c.id === id);
const failing = (input: CheckInput) => computeChecks(input).checks.filter((c) => !c.ok).map((c) => c.id);

describe('computeChecks', () => {
  it('passes every check, in the documented order, with no warnings when everything is in place', () => {
    const result = computeChecks(ready());
    expect(result.checks.map((c) => c.id)).toEqual([
      'token_valid',
      'client_id_matches',
      'public_bot_off',
      'intent_guild_members',
      'intent_message_content',
      'bot_in_guild',
      'permissions_present',
      'owner_bound',
      'owner_in_guild',
      'roles_mapped',
      'bot_role_above_mapped_roles',
    ]);
    expect(failing(ready())).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('marks everything not_yet before a token is stored', () => {
    const empty: CheckInput = {
      application: null,
      clientId: null,
      guilds: null,
      guildId: null,
      guild: null,
      ownerId: null,
      ownerMember: null,
      organizerRoleId: null,
      headJudgeRoleId: null,
    };
    const result = computeChecks(empty);
    expect(result.checks.every((c) => !c.ok && c.detail === 'not_yet')).toBe(true);
  });

  it('fails the token check for an invalid token, and reports Discord being down', () => {
    expect(check(ready({ application: 'invalid_token' }), 'token_valid')).toEqual({
      id: 'token_valid',
      ok: false,
      detail: 'invalid_token',
    });
    expect(check(ready({ application: 'unavailable' }), 'public_bot_off')).toEqual({
      id: 'public_bot_off',
      ok: false,
      detail: 'discord_unavailable',
    });
  });

  it('fails client_id_matches when the token belongs to another application', () => {
    expect(failing(ready({ clientId: '300000000000000009' }))).toEqual(['client_id_matches']);
  });

  it('fails public_bot_off while Public Bot is on', () => {
    expect(failing(ready({ application: app({ botPublic: true }) }))).toEqual(['public_bot_off']);
  });

  it('accepts the full or the limited flag for each privileged intent, and fails without either', () => {
    expect(failing(ready({ application: app({ flags: (1 << 15) | (1 << 19) }) }))).toEqual([]);
    expect(failing(ready({ application: app({ flags: 1 << 18 }) }))).toEqual(['intent_guild_members']);
    expect(failing(ready({ application: app({ flags: 1 << 14 }) }))).toEqual(['intent_message_content']);
  });

  it('fails bot_in_guild, and the checks that need the guild, when the bot is not in the chosen guild', () => {
    const input = ready({ guild: null });
    expect(check(input, 'bot_in_guild')).toEqual({ id: 'bot_in_guild', ok: false, detail: 'bot_not_in_guild' });
    expect(check(input, 'permissions_present')?.detail).toBe('not_yet');
  });

  it('marks the guild checks not_yet before a guild is chosen', () => {
    const input = ready({ guildId: null, guild: null });
    for (const id of ['bot_in_guild', 'permissions_present', 'roles_mapped', 'bot_role_above_mapped_roles']) {
      expect(check(input, id)?.detail).toBe('not_yet');
    }
  });

  it('names each missing invite permission', () => {
    const input = ready({ guild: guild({ botPermissions: ALL & ~PERMISSION_BITS.AddReactions }) });
    expect(check(input, 'permissions_present')).toEqual({
      id: 'permissions_present',
      ok: false,
      detail: ['AddReactions'],
    });
  });

  it('passes permissions for an Administrator bot, with a warning', () => {
    const result = computeChecks(ready({ guild: guild({ botPermissions: PERMISSION_BITS.Administrator }) }));
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(result.warnings).toEqual([{ id: 'bot_has_administrator' }]);
  });

  it('fails the owner checks until an owner is bound, and while the owner is not a member', () => {
    expect(failing(ready({ ownerId: null, ownerMember: null }))).toEqual(['owner_bound', 'owner_in_guild']);
    expect(check(ready({ ownerMember: null }), 'owner_in_guild')).toEqual({
      id: 'owner_in_guild',
      ok: false,
      detail: 'owner_not_in_guild',
    });
    expect(check(ready({ ownerMember: 'unavailable' }), 'owner_in_guild')?.detail).toBe('discord_unavailable');
  });

  it('cannot tell whether the owner is a member until the bot sees the chosen guild', () => {
    expect(check(ready({ guild: null, ownerMember: null }), 'owner_in_guild')?.detail).toBe('not_yet');
    expect(check(ready({ guildId: null, guild: null }), 'owner_in_guild')?.detail).toBe('not_yet');
    expect(check(ready({ guild: 'unavailable' }), 'owner_in_guild')?.detail).toBe('discord_unavailable');
  });

  it('fails roles_mapped until both roles are mapped, and names a mapped role that no longer exists', () => {
    expect(check(ready({ headJudgeRoleId: null }), 'roles_mapped')?.detail).toBe('not_yet');
    const gone = ready({ guild: guild({ roles: guild().roles.filter((r) => r.id !== HJ_ROLE) }) });
    expect(check(gone, 'roles_mapped')).toEqual({ id: 'roles_mapped', ok: false, detail: [HJ_ROLE] });
    expect(check(gone, 'bot_role_above_mapped_roles')?.detail).toBe('not_yet');
  });

  it('allows one role to be mapped as both organizer and head judge', () => {
    expect(failing(ready({ headJudgeRoleId: ORG_ROLE }))).toEqual([]);
  });

  it('fails when the bot role is at or below a mapped role', () => {
    expect(failing(ready({ guild: guild({ botHighestRolePosition: 3 }) }))).toEqual(['bot_role_above_mapped_roles']);
    expect(failing(ready({ guild: guild({ botHighestRolePosition: 4 }) }))).toEqual([]);
  });

  it('reports Discord being unavailable for the guild checks', () => {
    expect(check(ready({ guild: 'unavailable' }), 'bot_in_guild')?.detail).toBe('discord_unavailable');
    expect(check(ready({ guild: 'unavailable' }), 'roles_mapped')?.detail).toBe('discord_unavailable');
  });

  it('warns when the bot is also in other guilds', () => {
    const result = computeChecks(
      ready({
        guilds: [
          { id: GUILD, name: 'Store' },
          { id: '400000000000000002', name: 'Elsewhere' },
        ],
      }),
    );
    expect(result.warnings).toEqual([
      { id: 'bot_in_other_guilds', guilds: [{ id: '400000000000000002', name: 'Elsewhere' }] },
    ]);
  });
});
