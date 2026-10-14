import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeDiscordHttp, startFakeDiscordHttp } from '../support/fake-discord-http';
import { IDS, storeWorld } from '../support/discord-world';
import { type Genie, startGenie } from '../support/genie-process';
import { browser } from '../support/http-client';
import { credentials } from '../support/flows';

let discord: FakeDiscordHttp;
let genie: Genie;
const SITE = 'https://genie.example';
/** What Caddy sends on the shared Docker network (the test talks to 127.0.0.1, a trusted proxy by default). */
const viaCaddy = { host: 'genie.example', headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.168.1.40' } };

beforeAll(async () => {
  discord = await startFakeDiscordHttp(storeWorld());
  genie = await startGenie({ discordUrl: discord.url, env: { NUXT_PUBLIC_SITE_URL: SITE } });
});
afterAll(async () => {
  await genie.stop();
  await discord.close();
});

describe('behind Caddy with a site URL', () => {
  it('accepts the setup code and the application on the https site', async () => {
    const b = browser(genie.url, viaCaddy);
    expect((await b.post('/api/setup/unlock', { code: genie.setupCode() })).status).toBe(204);
    expect((await b.post('/api/setup/discord', credentials)).status).toBe(200);
  });

  it('pins the OAuth redirect to the site URL', async () => {
    const res = await browser(genie.url, viaCaddy).get('/auth/discord');
    const authorize = new URL(res.location!);
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${SITE}/auth/discord`);
    expect(authorize.searchParams.get('client_id')).toBe(IDS.app);
  });

  it('still allows the owner on localhost, and refuses plain http on the site host', async () => {
    const local = await browser(genie.url).get('/auth/discord');
    expect(new URL(local.location!).searchParams.get('redirect_uri')).toBe(`http://localhost:${genie.port}/auth/discord`);
    const plain = browser(genie.url, { host: 'genie.example', headers: { 'x-forwarded-proto': 'http' } });
    expect((await plain.get('/auth/discord')).status).toBe(403);
  });

  it('sends HSTS and upgrade-insecure-requests on an https site', async () => {
    const res = await browser(genie.url, viaCaddy).get('/healthz');
    expect(res.headers['strict-transport-security']).toBe('max-age=15552000');
    expect(String(res.headers['content-security-policy'])).toContain('upgrade-insecure-requests');
  });
});
