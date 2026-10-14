import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FakeDiscord } from '../../server/modules/discord/fake';
import { type FakeDiscordHttp, startFakeDiscordHttp } from '../support/fake-discord-http';
import { IDS, storeWorld } from '../support/discord-world';
import { type Genie, startGenie } from '../support/genie-process';
import { type Browser, browser } from '../support/http-client';
import { completeSetup, expectNoSecrets, loginThroughDiscord, replyTexts } from '../support/flows';

let fake: FakeDiscord;
let discord: FakeDiscordHttp;
let genie: Genie;
let owner: Browser;

beforeAll(async () => {
  fake = storeWorld();
  discord = await startFakeDiscordHttp(fake);
  genie = await startGenie({ discordUrl: discord.url, env: { NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '1000' } });
  owner = browser(genie.url);
  await completeSetup(owner, genie, discord);
});
afterAll(async () => {
  await genie.stop();
  await discord.close();
});

async function signedIn(userId: string): Promise<Browser> {
  const b = browser(genie.url);
  const res = await loginThroughDiscord(b, discord, userId);
  expect(res.location).toBe('/');
  return b;
}

const auditRows = async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(genie.dataDir.databasePath, { readonly: true });
  try {
    return db.prepare('select discord_user_id as user, "grant" from login_audit order by id').all() as { user: string; grant: string }[];
  } finally {
    db.close();
  }
};

describe('logging in', () => {
  it('admits an organizer-role holder with an audited grant', async () => {
    const b = await signedIn(IDS.organizer);
    expect((await b.get('/api/me')).json()).toEqual({
      user: { id: IDS.organizer, username: 'user0002', globalName: 'User 0002', avatar: null },
      grant: 'organizer_role',
      isOwner: false,
      isOrganizer: true,
    });
    expect((await auditRows()).at(-1)).toEqual({ user: IDS.organizer, grant: 'organizer_role' });
  });

  it('refuses a member without a grant and a non-member, without a session or an audit row', async () => {
    const before = (await auditRows()).length;
    const member = browser(genie.url);
    expect((await loginThroughDiscord(member, discord, IDS.member)).location).toBe('/login?error=no_access');
    expect((await member.get('/api/me')).status).toBe(401);
    const outsider = browser(genie.url);
    expect((await loginThroughDiscord(outsider, discord, IDS.outsider)).location).toBe('/login?error=not_in_guild');
    expect((await auditRows()).length).toBe(before);
  });

  it('starts the flow with a fixed redirect URL for the localhost origin and for the site behind Caddy', async () => {
    const local = await browser(genie.url).get('/auth/discord');
    const authorize = new URL(local.location!);
    expect(authorize.origin + authorize.pathname).toBe(`${discord.url}/oauth2/authorize`);
    expect(authorize.searchParams.get('redirect_uri')).toBe(`http://localhost:${genie.port}/auth/discord`);
    expect(authorize.searchParams.get('client_id')).toBe(IDS.app);
    expect(authorize.searchParams.get('scope')).toBe('identify');
    for (const cookie of local.setCookies) expect(cookie).toMatch(/Secure.*HttpOnly|HttpOnly.*Secure/i);

    expect((await browser(genie.url, { host: 'evil.example' }).get('/auth/discord')).json()).toMatchObject({
      statusCode: 403,
      data: { code: 'insecure_origin' },
    });
  });

  it('sends a failed token exchange, a mismatched state and a cancelled consent to the login page', async () => {
    discord.failTokenExchange = true;
    try {
      expect((await loginThroughDiscord(browser(genie.url), discord, IDS.organizer)).location).toBe('/login?error=login_failed');
    } finally {
      discord.failTokenExchange = false;
    }

    const b = browser(genie.url);
    await b.get('/auth/discord');
    expect((await b.get('/auth/discord?code=fake-code-x&state=forged')).location).toBe('/login?error=login_failed');
    expect((await b.get('/auth/discord?error=access_denied&state=x')).location).toBe('/login?error=login_failed');
    expect((await b.get('/api/me')).status).toBe(401);
  });
});

describe('route authorization', () => {
  it('answers each route by grant: nobody 401, organizer role, owner', async () => {
    const anonymous = browser(genie.url);
    const organizer = await signedIn(IDS.organizer);
    const routes = [
      ['GET', '/api/me'],
      ['GET', '/api/settings'],
      ['GET', '/api/status'],
      ['GET', '/api/settings/organizer-allowlist'],
      ['PUT', '/api/settings/organizer-allowlist'],
    ] as const;
    const body = { enabled: false, userIds: [] };
    for (const [method, path] of routes) {
      const opts = method === 'PUT' ? { method, json: body } : { method };
      const none = await anonymous.send(path, opts);
      expect(none.status, `${method} ${path} anonymous`).toBe(401);
      expect(none.json()).toMatchObject({ data: { code: 'unauthenticated' } });

      const asOrganizer = await organizer.send(path, opts);
      const ownerOnly = path.includes('allowlist');
      expect(asOrganizer.status, `${method} ${path} organizer`).toBe(ownerOnly ? 403 : 200);
      if (ownerOnly) expect(asOrganizer.json()).toMatchObject({ data: { code: 'owner_only' } });

      expect((await owner.send(path, opts)).status, `${method} ${path} owner`).toBe(200);
    }
    expect((await owner.get('/api/settings')).json()).toEqual({
      guild: { id: IDS.guild, name: 'Pallet Town Games' },
      organizerRole: { id: IDS.organizerRole, name: 'Organizer' },
      headJudgeRole: { id: IDS.headJudgeRole, name: 'Head judge' },
      ownerId: IDS.owner,
      organizerAllowlistEnabled: false,
    });
    expectNoSecrets([...replyTexts(owner), ...replyTexts(organizer), genie.log()]);
  });
});

describe('the organizer allowlist', () => {
  it('limits organizers to the owner and listed role holders, and warns when it is empty', async () => {
    const empty = await owner.put('/api/settings/organizer-allowlist', { enabled: true, userIds: [] });
    expect(empty.json()).toEqual({ enabled: true, userIds: [], warnings: ['empty_allowlist'] });
    expect((await loginThroughDiscord(browser(genie.url), discord, IDS.organizer)).location).toBe('/login?error=no_access');
    expect((await loginThroughDiscord(browser(genie.url), discord, IDS.owner)).location).toBe('/');

    await owner.put('/api/settings/organizer-allowlist', { enabled: true, userIds: [IDS.organizer] });
    const listed = await signedIn(IDS.organizer);
    expect((await listed.get('/api/me')).json()).toMatchObject({ grant: 'allowlist' });
    await owner.put('/api/settings/organizer-allowlist', { enabled: false, userIds: [] });
  });

  it.each([
    ['duplicate IDs', { enabled: true, userIds: [IDS.organizer, IDS.organizer] }],
    ['a non-snowflake', { enabled: true, userIds: ['not-an-id'] }],
    ['101 IDs', { enabled: true, userIds: Array.from({ length: 101 }, (_, i) => String(100000000000000100n + BigInt(i))) }],
    ['a missing flag', { userIds: [] }],
  ])('refuses a body with %s', async (_name, body) => {
    const res = await owner.put('/api/settings/organizer-allowlist', body);
    expect(res.status).toBe(400);
    expect(res.json()).toMatchObject({ data: { code: 'invalid_body' } });
  });
});
