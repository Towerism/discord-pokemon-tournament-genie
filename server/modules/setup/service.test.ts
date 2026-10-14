import { silentLogger } from '@towerism/selfhost-kit';
import { type FakeClock, fakeClock } from '@towerism/selfhost-kit/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from '../../../test/support/db';
import { BOT_TOKEN, CLIENT_SECRET, IDS, storeWorld, testVault } from '../../../test/support/discord-world';
import type { OpenDatabase } from '../../db/client';
import type { FakeDiscord } from '../discord/fake';
import { type SetupService, SetupError, createSetupService } from './service';
import { createSetupStore } from './store';

let database: OpenDatabase;
let clock: FakeClock;
let discord: FakeDiscord;
let vault: ReturnType<typeof testVault>;
let completed: number;
let setup: SetupService;

beforeEach(() => {
  database = freshDb();
  clock = fakeClock(1_000);
  discord = storeWorld();
  vault = testVault();
  completed = 0;
  setup = createSetupService({
    store: createSetupStore(database.db),
    vault,
    createDiscord: discord.create,
    clock,
    logger: silentLogger,
    onComplete: () => {
      completed += 1;
    },
  });
});
afterEach(() => database.close());

const credentials = { botToken: BOT_TOKEN, clientId: IDS.app, clientSecret: CLIENT_SECRET };
const failing = (checks: { checks: { id: string; ok: boolean }[] }) => checks.checks.filter((c) => !c.ok).map((c) => c.id);
const sealedRows = () => database.sqlite.prepare('select name, ciphertext from sealed_secret order by name').all() as { name: string; ciphertext: Buffer }[];

async function expectSetupError(promise: Promise<unknown>, status: number, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SetupError);
  expect(err).toMatchObject({ status, code });
}

/** Everything up to finishing: credentials, guild, owner, roles. */
async function readyToFinish() {
  await setup.saveDiscord(credentials);
  await setup.chooseGuild(IDS.guild);
  expect(await setup.bindOwner(IDS.owner)).toBe('bound');
  await setup.mapRoles(IDS.owner, { organizerRoleId: IDS.organizerRole, headJudgeRoleId: IDS.headJudgeRole });
}

describe('the Discord application step', () => {
  it('stores the token and secret only as vault blobs bound to their rows, and answers checks and the invite URL', async () => {
    const result = await setup.saveDiscord(credentials);
    expect(result.inviteUrl).toContain(`client_id=${IDS.app}`);
    expect(result.checks.slice(0, 5).every((c) => c.ok)).toBe(true);

    const rows = sealedRows();
    expect(rows.map((r) => r.name)).toEqual(['discord_bot_token', 'discord_client_secret']);
    expect(vault.decrypt(rows[0]!.ciphertext, 'sealed_secret:discord_bot_token')).toBe(BOT_TOKEN);
    expect(vault.decrypt(rows[1]!.ciphertext, 'sealed_secret:discord_client_secret')).toBe(CLIENT_SECRET);
    expect(() => vault.decrypt(rows[0]!.ciphertext, 'sealed_secret:discord_client_secret')).toThrow();
    expect(rows[0]!.ciphertext.toString('utf8')).not.toContain(BOT_TOKEN);
    expect(setup.progress()).toMatchObject({ clientId: IDS.app, inviteUrl: result.inviteUrl });
    expect(JSON.stringify(setup.progress())).not.toContain(CLIENT_SECRET);
  });

  it('refuses an invalid token, a token for another application, and Discord being down, storing nothing', async () => {
    await expectSetupError(setup.saveDiscord({ ...credentials, botToken: 'fake-bot-token-wrong' }), 422, 'invalid_bot_token');
    await expectSetupError(setup.saveDiscord({ ...credentials, clientId: '300000000000000009' }), 422, 'client_id_mismatch');
    discord.unavailable = true;
    await expectSetupError(setup.saveDiscord(credentials), 502, 'discord_unavailable');
    expect(sealedRows()).toEqual([]);
    expect(setup.progress().clientId).toBeNull();
  });

  it('still stores the credentials when Public Bot is on, and reports it as a failing check', async () => {
    discord.applications.get(IDS.app)!.botPublic = true;
    const result = await setup.saveDiscord(credentials);
    expect(failing(result)).toContain('public_bot_off');
    expect(sealedRows()).toHaveLength(2);
  });
});

describe('the guild step', () => {
  it('lists the guilds the bot is in and binds the chosen one', async () => {
    await setup.saveDiscord(credentials);
    expect(await setup.guilds()).toEqual([{ id: IDS.guild, name: 'Pallet Town Games' }]);
    const checks = await setup.chooseGuild(IDS.guild);
    expect(checks.checks.find((c) => c.id === 'bot_in_guild')?.ok).toBe(true);
    expect(setup.progress().guild).toEqual({ id: IDS.guild, name: 'Pallet Town Games' });
  });

  it('refuses a guild the bot is not in', async () => {
    await setup.saveDiscord(credentials);
    discord.addGuild({ id: IDS.otherGuild, name: 'Elsewhere' });
    await expectSetupError(setup.chooseGuild(IDS.otherGuild), 422, 'bot_not_in_guild');
    expect(setup.progress().guild).toBeNull();
  });

  it('needs the Discord application first', async () => {
    await expectSetupError(setup.guilds(), 409, 'discord_not_configured');
  });

  it('clears the roles, and an owner who is not a member, when the guild changes', async () => {
    await readyToFinish();
    discord.addGuild({ id: IDS.otherGuild, name: 'Elsewhere' });
    discord.inviteBot(IDS.app, IDS.otherGuild);
    await setup.chooseGuild(IDS.otherGuild);
    expect(setup.progress()).toMatchObject({ ownerId: null, organizerRoleId: null, headJudgeRoleId: null });
  });

  it('keeps an owner who is also a member of the new guild', async () => {
    await readyToFinish();
    discord.addGuild({ id: IDS.otherGuild, name: 'Elsewhere' });
    discord.inviteBot(IDS.app, IDS.otherGuild);
    discord.addMember(IDS.otherGuild, IDS.owner);
    await setup.chooseGuild(IDS.otherGuild);
    expect(setup.progress().ownerId).toBe(IDS.owner);
  });
});

describe('the owner', () => {
  it('needs a chosen guild, and membership of it', async () => {
    await setup.saveDiscord(credentials);
    expect(await setup.bindOwner(IDS.owner)).toBe('choose_guild_first');
    await setup.chooseGuild(IDS.guild);
    expect(await setup.bindOwner(IDS.outsider)).toBe('owner_not_in_guild');
    expect(setup.progress().ownerId).toBeNull();
    expect(await setup.bindOwner(IDS.owner)).toBe('bound');
    expect(setup.progress().ownerId).toBe(IDS.owner);
  });
});

describe('the roles step', () => {
  it('lists the guild roles without @everyone or managed roles, highest first', async () => {
    await setup.saveDiscord(credentials);
    await expectSetupError(setup.roles(), 409, 'guild_not_chosen');
    await setup.chooseGuild(IDS.guild);
    expect(await setup.roles()).toEqual([
      { id: IDS.organizerRole, name: 'Organizer', position: 2 },
      { id: IDS.headJudgeRole, name: 'Head judge', position: 1 },
    ]);
  });

  it('maps roles for the owner only, and only roles of the guild', async () => {
    await setup.saveDiscord(credentials);
    await setup.chooseGuild(IDS.guild);
    await setup.bindOwner(IDS.owner);
    const roles = { organizerRoleId: IDS.organizerRole, headJudgeRoleId: IDS.headJudgeRole };
    await expectSetupError(setup.mapRoles(IDS.organizer, roles), 403, 'owner_required');
    await expectSetupError(setup.mapRoles(IDS.owner, { ...roles, headJudgeRoleId: '200000000000000099' }), 422, 'unknown_role');
    const checks = await setup.mapRoles(IDS.owner, roles);
    expect(failing(checks)).toEqual([]);
  });
});

describe('finishing', () => {
  it('refuses while a check fails, and changes nothing', async () => {
    await readyToFinish();
    discord.applications.get(IDS.app)!.botPublic = true;
    const err = await setup.finish().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: 'setup_checks_failed' });
    expect(failing((err as SetupError).data as { checks: { id: string; ok: boolean }[] })).toEqual(['public_bot_off']);
    expect(setup.isComplete()).toBe(false);
    expect(completed).toBe(0);
  });

  it('completes once every check passes, then refuses every setup step with 410', async () => {
    await readyToFinish();
    await setup.finish();
    expect(setup.isComplete()).toBe(true);
    expect(completed).toBe(1);
    expect(database.sqlite.prepare('select setup_completed_at from install').pluck().get()).toBe(1_000);

    expect(() => setup.assertIncomplete()).toThrow(expect.objectContaining({ status: 410, code: 'setup_complete' }));
    await expectSetupError(setup.saveDiscord(credentials), 410, 'setup_complete');
    await expectSetupError(setup.chooseGuild(IDS.guild), 410, 'setup_complete');
    await expectSetupError(setup.finish(), 410, 'setup_complete');
    expect(await setup.bindOwner(IDS.organizer)).toBe('setup_complete');
    expect(setup.progress().ownerId).toBe(IDS.owner);
  });

  it('reports Discord being down as failing checks, not as an error', async () => {
    await readyToFinish();
    discord.unavailable = true;
    const checks = await setup.check();
    expect(checks.checks.find((c) => c.id === 'token_valid')).toEqual({ id: 'token_valid', ok: false, detail: 'discord_unavailable' });
    expect(setup.progress().lastChecks).toEqual(checks);
  });
});

describe('the stored credentials', () => {
  it('unseal for login and the bot, and report an unreadable vault as secrets_unreadable', async () => {
    expect(setup.oauthClient()).toBeNull();
    await setup.saveDiscord(credentials);
    expect(setup.oauthClient()).toEqual({ clientId: IDS.app, clientSecret: CLIENT_SECRET });
    expect(setup.botToken()).toBe(BOT_TOKEN);

    const other = createSetupService({
      store: createSetupStore(database.db),
      vault: testVault(),
      createDiscord: discord.create,
      clock,
      logger: silentLogger,
    });
    expect(() => other.botToken()).toThrow(expect.objectContaining({ status: 503, code: 'secrets_unreadable' }));
    expect(() => other.oauthClient()).toThrow(expect.objectContaining({ status: 503, code: 'secrets_unreadable' }));
  });
});
