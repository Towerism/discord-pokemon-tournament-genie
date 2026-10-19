import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { createFakeDiscord } from '../../server/modules/discord/fake';
import { type FakeDiscordHttp, startFakeDiscordHttp } from '../support/fake-discord-http';
import { IDS, storeWorld } from '../support/discord-world';
import { type Genie, startGenie } from '../support/genie-process';
import { browser } from '../support/http-client';
import { attackerCallback, completeSetup, credentials, expectNoSecrets, loginThroughDiscord, mintCodeOutsideGenie, replyTexts, unlock } from '../support/flows';

let fake: ReturnType<typeof createFakeDiscord>;
let discord: FakeDiscordHttp;
let genie: Genie;

beforeAll(async () => {
  fake = storeWorld();
  discord = await startFakeDiscordHttp(fake);
  // The unlock limit (5 per 15 min) has its own file; these tests unlock many browsers.
  genie = await startGenie({ discordUrl: discord.url, env: { NUXT_AUTH_RATE_LIMIT_SETUP_MAX: '1000', NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '1000' } });
});
afterAll(async () => {
  await genie.stop();
  await discord.close();
});

describe('first boot', () => {
  it('generates the secrets with mode 0600, logs where they came from and prints one setup code', async () => {
    const log = genie.log();
    expect(log).toMatch(/Session password: generated into .*session-password/);
    expect(log).toMatch(/Vault key: generated into .*vault\.key/);
    expect(log.match(/Setup isn't finished\. Open \/setup and enter this setup code: [A-Z0-9]{4}-[A-Z0-9]{4}/g)).toHaveLength(1);
    const key = readFileSync(`${genie.dataDir.secretsDir}/vault.key`, 'utf8').trim();
    expect(log).not.toContain(key);
    const { statSync } = await import('node:fs');
    expect(statSync(`${genie.dataDir.secretsDir}/vault.key`).mode & 0o777).toBe(0o600);
    expect(statSync(genie.dataDir.secretsDir).mode & 0o777).toBe(0o700);
  });

  it('answers liveness and readiness while the bot is not set up', async () => {
    expect(await (await fetch(`${genie.url}/healthz`)).json()).toEqual({ status: 'ok' });
    expect(await (await fetch(`${genie.url}/readyz`)).json()).toEqual({ status: 'ready' });
  });
});

describe('the setup lock', () => {
  it('refuses a wrong code and every later step until the right code is entered', async () => {
    const b = browser(genie.url);
    const wrong = await b.post('/api/setup/unlock', { code: 'AAAA-AAAA' });
    expect(wrong.status).toBe(403);
    expect(wrong.json()).toMatchObject({ data: { code: 'invalid_setup_code' } });
    expect((await b.post('/api/setup/discord', credentials)).json()).toMatchObject({ statusCode: 403, data: { code: 'setup_locked' } });
    expect((await b.get('/api/setup/guilds')).status).toBe(403);
    expect((await b.get('/api/setup')).json()).toMatchObject({ complete: false, unlocked: false });

    await unlock(b, genie);
    expect((await b.get('/api/setup')).json()).toMatchObject({ unlocked: true });
  });

  it('sets the session cookie Secure, HttpOnly and SameSite=Lax, even on http://localhost', async () => {
    const b = browser(genie.url);
    await unlock(b, genie);
    const cookie = b.replies.flatMap((r) => r.setCookies);
    expect(cookie.length).toBeGreaterThan(0);
    for (const c of cookie) {
      expect(c).toMatch(/;\s*Secure/i);
      expect(c).toMatch(/;\s*HttpOnly/i);
      expect(c).toMatch(/;\s*SameSite=Lax/i);
    }
  });

  it('refuses secrets on an origin that is not the site URL or localhost', async () => {
    const lan = browser(genie.url, { host: `192.168.1.5:${genie.port}` });
    const res = await lan.post('/api/setup/unlock', { code: genie.setupCode() });
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({ data: { code: 'insecure_origin' } });
    const spoofed = browser(genie.url, { host: 'genie.example', headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'genie.example' } });
    expect((await spoofed.post('/api/setup/unlock', { code: genie.setupCode() })).status).toBe(403);
    expect((await browser(genie.url, { host: `localhost:${genie.port + 1}` }).get('/auth/discord')).status).toBe(403);
  });

  it('refuses a body that is not JSON before any handler runs', async () => {
    const res = await browser(genie.url).send('/api/setup/unlock', {
      method: 'POST',
      body: 'code=abc',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).toBe(415);
  });
});

describe('the Discord application step', () => {
  it('verifies the token live and refuses an invalid token, another application and Discord being down', async () => {
    const b = browser(genie.url);
    await unlock(b, genie);
    expect((await b.post('/api/setup/discord', { ...credentials, botToken: 'fake-bot-token-wrong-0000' })).json()).toMatchObject({
      statusCode: 422,
      data: { code: 'invalid_bot_token' },
    });
    expect((await b.post('/api/setup/discord', { ...credentials, clientId: '300000000000000009' })).json()).toMatchObject({
      statusCode: 422,
      data: { code: 'client_id_mismatch' },
    });
    fake.unavailable = true;
    try {
      expect((await b.post('/api/setup/discord', credentials)).json()).toMatchObject({ statusCode: 502, data: { code: 'discord_unavailable' } });
    } finally {
      fake.unavailable = false;
    }
    expect((await b.get('/api/setup')).json()).toMatchObject({ clientId: null });
    expect((await b.post('/api/setup/discord', { botToken: 'x' })).json()).toMatchObject({ statusCode: 400, data: { code: 'invalid_body' } });
  });

  it('stores the application and answers the checks and the 14-permission invite URL', async () => {
    const b = browser(genie.url);
    await unlock(b, genie);
    const res = await b.post('/api/setup/discord', credentials);
    expect(res.status).toBe(200);
    const body = res.json<{ inviteUrl: string; checks: { id: string; ok: boolean }[] }>();
    expect(new URL(body.inviteUrl).searchParams.get('permissions')).toBe('2252197366713424');
    expect(body.checks.find((c) => c.id === 'token_valid')?.ok).toBe(true);
    expectNoSecrets(replyTexts(b));
  });
});

describe('the guild, owner and roles steps', () => {
  it('chooses a guild the bot is in and refuses one it is not in', async () => {
    const b = browser(genie.url);
    await unlock(b, genie);
    await b.post('/api/setup/discord', credentials);
    expect((await b.get('/api/setup/guilds')).json()).toEqual({ guilds: [{ id: IDS.guild, name: 'Pallet Town Games' }] });
    fake.addGuild({ id: IDS.otherGuild, name: 'Elsewhere' });
    expect((await b.post('/api/setup/guild', { guildId: IDS.otherGuild })).json()).toMatchObject({ statusCode: 422, data: { code: 'bot_not_in_guild' } });
    expect((await b.post('/api/setup/guild', { guildId: IDS.guild })).status).toBe(200);
  });

  it('binds the owner only from the unlocked browser, and only a member of the guild', async () => {
    const stranger = browser(genie.url);
    expect((await loginThroughDiscord(stranger, discord, IDS.owner)).location).toBe('/login?error=setup_incomplete');
    expect((await stranger.get('/api/me')).status).toBe(401);
    expect((await browser(genie.url).get('/api/setup')).json()).toMatchObject({ ownerId: null });

    const b = browser(genie.url);
    await unlock(b, genie);
    expect((await loginThroughDiscord(b, discord, IDS.outsider)).location).toBe('/setup?error=owner_not_in_guild');
    expect((await loginThroughDiscord(b, discord, IDS.owner)).location).toBe('/setup');
    expect((await b.get('/api/setup')).json()).toMatchObject({ ownerId: IDS.owner });
  });

  it.each([
    ['no state at all', (code: string) => `/auth/discord?code=${code}`],
    ['an empty state', (code: string) => `/auth/discord?code=${code}&state=`],
  ])('never binds an attacker as owner through a callback with %s (login CSRF)', async (_name, link) => {
    const victim = browser(genie.url);
    await unlock(victim, genie);
    const ownerBefore = (await victim.get('/api/setup')).json<{ ownerId: string | null }>().ownerId;
    const code = await mintCodeOutsideGenie(discord, genie, IDS.member);
    const res = await victim.get(link(code));
    expect(res.location).toBe('/login?error=login_failed');
    expect((await victim.get('/api/setup')).json()).toMatchObject({ ownerId: ownerBefore });
  });

  it("never binds an attacker who hands over their own login's state and code", async () => {
    const victim = browser(genie.url);
    await unlock(victim, genie);
    const ownerBefore = (await victim.get('/api/setup')).json<{ ownerId: string | null }>().ownerId;
    const { code, state } = await attackerCallback(discord, genie, IDS.member);

    // The victim never started a login.
    expect((await victim.get(`/auth/discord?code=${code}&state=${state}`)).location).toBe('/login?error=login_failed');
    // A sibling site planted the state cookie (cookies ignore ports and can be set for a parent domain).
    victim.cookies.set('nuxt-auth-state', state);
    expect((await victim.get(`/auth/discord?code=${code}&state=${state}`)).location).toBe('/login?error=login_failed');
    // The victim started a login of their own, then followed the attacker's link.
    await victim.get('/auth/discord');
    const second = await attackerCallback(discord, genie, IDS.member);
    expect((await victim.get(`/auth/discord?code=${second.code}&state=${second.state}`)).location).toBe('/login?error=login_failed');

    expect((await victim.get('/api/setup')).json()).toMatchObject({ ownerId: ownerBefore, unlocked: true });
  });

  it('maps roles for the owner only', async () => {
    const notOwner = browser(genie.url);
    await unlock(notOwner, genie);
    const body = { organizerRoleId: IDS.organizerRole, headJudgeRoleId: IDS.headJudgeRole };
    expect((await notOwner.post('/api/setup/roles', body)).json()).toMatchObject({ statusCode: 403, data: { code: 'owner_required' } });

    const owner = browser(genie.url);
    await unlock(owner, genie);
    await loginThroughDiscord(owner, discord, IDS.owner);
    expect((await owner.get('/api/setup/roles')).json()).toEqual({
      roles: [
        { id: IDS.organizerRole, name: 'Organizer', position: 2 },
        { id: IDS.headJudgeRole, name: 'Head judge', position: 1 },
      ],
    });
    expect((await owner.post('/api/setup/roles', { ...body, headJudgeRoleId: '200000000000000099' })).json()).toMatchObject({
      statusCode: 422,
      data: { code: 'unknown_role' },
    });
    expect((await owner.post('/api/setup/roles', body)).status).toBe(200);
  });
});

describe('finishing setup', () => {
  it('refuses while a check fails, then completes, starts the bot and locks every setup route with 410', async () => {
    const b = browser(genie.url);
    fake.applications.get(IDS.app)!.botPublic = true;
    await unlock(b, genie);
    const refused = await b.post('/api/setup/finish');
    expect(refused.json()).toMatchObject({ statusCode: 422, data: { code: 'setup_checks_failed' } });
    expect(refused.json<{ data: { checks: { id: string; ok: boolean }[] } }>().data.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual([
      'public_bot_off',
    ]);
    fake.applications.get(IDS.app)!.botPublic = false;

    const owner = browser(genie.url);
    await completeSetup(owner, genie, discord);

    const status = await owner.get('/api/status');
    expect(status.status).toBe(200);
    expect(['connecting', 'error']).toContain(status.json<{ state: string }>().state);

    const oldCode = genie.setupCode();
    for (const [method, path] of [
      ['GET', '/api/setup'],
      ['POST', '/api/setup/unlock'],
      ['POST', '/api/setup/discord'],
      ['GET', '/api/setup/guilds'],
      ['POST', '/api/setup/guild'],
      ['GET', '/api/setup/roles'],
      ['POST', '/api/setup/roles'],
      ['POST', '/api/setup/check'],
      ['POST', '/api/setup/finish'],
    ] as const) {
      const res = await owner.send(path, { method, ...(method === 'POST' ? { json: { code: oldCode } } : {}) });
      expect(res.status, `${method} ${path}`).toBe(410);
      expect(res.json()).toMatchObject({ data: { code: 'setup_complete' } });
    }
    expectNoSecrets([...replyTexts(owner), genie.log()]);
  });
});
