import { silentLogger } from '@towerism/selfhost-kit';
import { type FakeClock, fakeClock } from '@towerism/selfhost-kit/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from '../../../test/support/db';
import { BOT_TOKEN, CLIENT_SECRET, IDS, storeWorld, testVault } from '../../../test/support/discord-world';
import type { OpenDatabase } from '../../db/client';
import type { FakeDiscord } from '../discord/fake';
import { type LoginService, SESSION_REFRESH_MS, createLoginService } from './login';
import { type SetupService, createSetupService } from './service';
import { createSettingsService } from './settings';
import { type SetupStore, createSetupStore } from './store';

let database: OpenDatabase;
let clock: FakeClock;
let discord: FakeDiscord;
let store: SetupStore;
let setup: SetupService;
let login: LoginService;

const user = (id: string) => ({ id, username: `user${id.slice(-1)}`, globalName: null, avatar: null });

beforeEach(() => {
  database = freshDb();
  clock = fakeClock(5_000);
  discord = storeWorld();
  store = createSetupStore(database.db);
  setup = createSetupService({ store, vault: testVault(), createDiscord: discord.create, clock, logger: silentLogger });
  login = createLoginService({ store, setup, createDiscord: discord.create, clock, logger: silentLogger });
});
afterEach(() => database.close());

async function prepareUntilOwner() {
  await setup.saveDiscord({ botToken: BOT_TOKEN, clientId: IDS.app, clientSecret: CLIENT_SECRET });
  await setup.chooseGuild(IDS.guild);
}
async function completeSetup() {
  await prepareUntilOwner();
  await login.complete({ user: user(IDS.owner), unlocked: true });
  await setup.mapRoles(IDS.owner, { organizerRoleId: IDS.organizerRole, headJudgeRoleId: IDS.headJudgeRole });
  await setup.finish();
}
const audit = () => store.auditRows().map((r) => [r.discordUserId, r.grant, r.at]);

describe('logging in during setup', () => {
  it('binds the owner from the unlocked wizard session, audits it and returns to the wizard', async () => {
    await prepareUntilOwner();
    const outcome = await login.complete({ user: user(IDS.owner), unlocked: true });
    expect(outcome).toEqual({
      redirect: '/setup',
      session: { user: user(IDS.owner), grant: 'owner', holdsHeadJudgeRole: false, checkedAt: 5_000 },
    });
    expect(setup.progress().ownerId).toBe(IDS.owner);
    expect(audit()).toEqual([[IDS.owner, 'owner', 5_000]]);
  });

  it('never binds an owner from a session that did not unlock setup', async () => {
    await prepareUntilOwner();
    expect(await login.complete({ user: user(IDS.owner), unlocked: false })).toEqual({ redirect: '/login?error=setup_incomplete' });
    expect(setup.progress().ownerId).toBeNull();
    expect(audit()).toEqual([]);
  });

  it('sends the wizard back with a reason when the guild is not chosen or the user is not a member', async () => {
    await setup.saveDiscord({ botToken: BOT_TOKEN, clientId: IDS.app, clientSecret: CLIENT_SECRET });
    expect(await login.complete({ user: user(IDS.owner), unlocked: true })).toEqual({ redirect: '/setup?error=choose_guild_first' });
    await setup.chooseGuild(IDS.guild);
    expect(await login.complete({ user: user(IDS.outsider), unlocked: true })).toEqual({ redirect: '/setup?error=owner_not_in_guild' });
    discord.unavailable = true;
    expect(await login.complete({ user: user(IDS.owner), unlocked: true })).toEqual({ redirect: '/setup?error=discord_unavailable' });
    expect(setup.progress().ownerId).toBeNull();
    expect(audit()).toEqual([]);
  });
});

describe('logging in after setup', () => {
  beforeEach(completeSetup);

  it('admits an organizer-role holder, audits the grant and goes home', async () => {
    clock.advance(1_000);
    expect(await login.complete({ user: user(IDS.organizer), unlocked: false })).toEqual({
      redirect: '/',
      session: { user: user(IDS.organizer), grant: 'organizer_role', holdsHeadJudgeRole: false, checkedAt: 6_000 },
    });
    expect(audit().at(-1)).toEqual([IDS.organizer, 'organizer_role', 6_000]);
  });

  it('ignores an unlocked flag once setup is complete', async () => {
    expect(await login.complete({ user: user(IDS.member), unlocked: true })).toEqual({ redirect: '/login?error=no_access' });
    expect(setup.progress().ownerId).toBe(IDS.owner);
  });

  it('refuses members without a grant and non-members, with no session and no audit row', async () => {
    const before = audit().length;
    expect(await login.complete({ user: user(IDS.member), unlocked: false })).toEqual({ redirect: '/login?error=no_access' });
    expect(await login.complete({ user: user(IDS.outsider), unlocked: false })).toEqual({ redirect: '/login?error=not_in_guild' });
    expect(audit()).toHaveLength(before);
  });

  it('reports Discord being down instead of guessing', async () => {
    discord.unavailable = true;
    expect(await login.complete({ user: user(IDS.organizer), unlocked: false })).toEqual({ redirect: '/login?error=discord_unavailable' });
  });

  it('follows the owner-only allowlist', async () => {
    const settings = createSettingsService({ store, setup, createDiscord: discord.create, clock, logger: silentLogger });
    expect(settings.putAllowlist({ enabled: true, userIds: [] })).toEqual({ enabled: true, userIds: [], warnings: ['empty_allowlist'] });
    expect(await login.complete({ user: user(IDS.organizer), unlocked: false })).toEqual({ redirect: '/login?error=no_access' });
    expect((await login.complete({ user: user(IDS.owner), unlocked: false })).redirect).toBe('/');

    expect(settings.putAllowlist({ enabled: true, userIds: [IDS.organizer] })).toEqual({
      enabled: true,
      userIds: [IDS.organizer],
      warnings: [],
    });
    const outcome = await login.complete({ user: user(IDS.organizer), unlocked: false });
    expect(outcome.session?.grant).toBe('allowlist');
  });
});

describe('refreshing a session', () => {
  beforeEach(completeSetup);
  const organizerSession = () => ({ user: user(IDS.organizer), grant: 'organizer_role' as const, checkedAt: clock.now() });

  it('trusts a session younger than 15 minutes without asking Discord', async () => {
    const session = organizerSession();
    clock.advance(SESSION_REFRESH_MS - 1);
    discord.unavailable = true;
    expect(await login.refresh(session)).toEqual({ action: 'keep' });
  });

  it('revokes a session whose member lost the organizer role', async () => {
    const session = organizerSession();
    clock.advance(SESSION_REFRESH_MS);
    discord.guilds.get(IDS.guild)!.members.set(IDS.organizer, []);
    expect(await login.refresh(session)).toEqual({ action: 'revoke' });
  });

  it('revokes a session whose member left the guild', async () => {
    const session = organizerSession();
    clock.advance(SESSION_REFRESH_MS);
    discord.removeMember(IDS.guild, IDS.organizer);
    expect(await login.refresh(session)).toEqual({ action: 'revoke' });
  });

  it('renews a session that still qualifies, with its current grant', async () => {
    const session = organizerSession();
    clock.advance(SESSION_REFRESH_MS);
    createSettingsService({ store, setup, createDiscord: discord.create, clock, logger: silentLogger }).putAllowlist({
      enabled: true,
      userIds: [IDS.organizer],
    });
    expect(await login.refresh(session)).toEqual({ action: 'update', grant: 'allowlist', holdsHeadJudgeRole: false, checkedAt: clock.now() });
  });

  it('keeps the session but refuses the request while Discord is down', async () => {
    const session = organizerSession();
    clock.advance(SESSION_REFRESH_MS);
    discord.unavailable = true;
    expect(await login.refresh(session)).toEqual({ action: 'unavailable' });
  });
});

describe('head-judge logins', () => {
  /** Day head judges of some non-purged day, as the event-days module would answer. */
  let eventHeadJudges: Set<string>;
  let roleOnStaff: Set<string>;

  beforeEach(async () => {
    eventHeadJudges = new Set([IDS.member]);
    roleOnStaff = new Set();
    login = createLoginService({
      store,
      setup,
      createDiscord: discord.create,
      clock,
      logger: silentLogger,
      dayHeadJudge: (userId, holdsHeadJudgeRole) => eventHeadJudges.has(userId) || (holdsHeadJudgeRole && roleOnStaff.has(userId)),
    });
    await completeSetup();
  });

  it('admits an event head judge with the event_head_judge grant, audited', async () => {
    const outcome = await login.complete({ user: user(IDS.member), unlocked: false });
    expect(outcome).toEqual({ redirect: '/', session: { user: user(IDS.member), grant: 'event_head_judge', holdsHeadJudgeRole: false, checkedAt: 5_000 } });
    expect(audit()).toContainEqual([IDS.member, 'event_head_judge', 5_000]);
  });

  it('refuses a plain judge', async () => {
    eventHeadJudges.clear();
    expect(await login.complete({ user: user(IDS.member), unlocked: false })).toEqual({ redirect: '/login?error=no_access' });
  });

  it('revokes a head judge removed from the day after 15 minutes', async () => {
    const session = (await login.complete({ user: user(IDS.member), unlocked: false })).session!;
    eventHeadJudges.clear();
    clock.advance(SESSION_REFRESH_MS);
    expect(await login.refresh(session)).toEqual({ action: 'revoke' });
  });

  it('keeps a staffer who gains the head-judge role, recording the role', async () => {
    const session = (await login.complete({ user: user(IDS.member), unlocked: false })).session!;
    eventHeadJudges.clear();
    roleOnStaff.add(IDS.member);
    discord.guilds.get(IDS.guild)!.members.set(IDS.member, [IDS.headJudgeRole]);
    clock.advance(SESSION_REFRESH_MS);
    expect(await login.refresh(session)).toEqual({ action: 'update', grant: 'event_head_judge', holdsHeadJudgeRole: true, checkedAt: clock.now() });
  });
});

describe('settings', () => {
  beforeEach(completeSetup);

  it('shows the guild, the mapped roles with their names and the owner, never a secret', async () => {
    const settings = createSettingsService({ store, setup, createDiscord: discord.create, clock, logger: silentLogger });
    const shown = await settings.settings();
    expect(shown).toEqual({
      guild: { id: IDS.guild, name: 'Pallet Town Games' },
      organizerRole: { id: IDS.organizerRole, name: 'Organizer' },
      headJudgeRole: { id: IDS.headJudgeRole, name: 'Head judge' },
      ownerId: IDS.owner,
      organizerAllowlistEnabled: false,
      currentSeason: '2026-27',
    });
    expect(JSON.stringify(shown)).not.toContain(CLIENT_SECRET);

    discord.unavailable = true;
    expect((await settings.settings()).organizerRole).toEqual({ id: IDS.organizerRole, name: null });
  });

  it('keeps when each allowlisted user was first added', () => {
    const settings = createSettingsService({ store, setup, createDiscord: discord.create, clock, logger: silentLogger });
    settings.putAllowlist({ enabled: false, userIds: [IDS.organizer] });
    clock.advance(10);
    settings.putAllowlist({ enabled: false, userIds: [IDS.member, IDS.organizer] });
    expect(settings.allowlist()).toEqual({ enabled: false, userIds: [IDS.organizer, IDS.member] });
  });
});
