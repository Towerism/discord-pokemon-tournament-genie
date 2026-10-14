import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeDiscordHttp, startFakeDiscordHttp } from '../support/fake-discord-http';
import { storeWorld } from '../support/discord-world';
import { type Genie, startGenie } from '../support/genie-process';
import { browser } from '../support/http-client';
import { credentials, unlock } from '../support/flows';

let discord: FakeDiscordHttp;
let genie: Genie;

beforeEach(async () => {
  discord = await startFakeDiscordHttp(storeWorld());
  genie = await startGenie({ discordUrl: discord.url });
});
afterEach(async () => {
  await genie.stop();
  await discord.close();
});

describe('the setup unlock rate limit', () => {
  it('refuses a sixth attempt within 15 minutes, even with the right code', async () => {
    const b = browser(genie.url);
    for (let i = 0; i < 5; i += 1) expect((await b.post('/api/setup/unlock', { code: 'AAAA-AAAA' })).status).toBe(403);
    const sixth = await b.post('/api/setup/unlock', { code: genie.setupCode() });
    expect(sixth.status).toBe(429);
    expect(sixth.headers['retry-after']).toMatch(/^\d+$/);
    expect(sixth.json()).toMatchObject({ data: { code: 'rate_limited' } });
  });
});

describe('a restart', () => {
  it('prints a new code and locks a browser that unlocked before it', async () => {
    const b = browser(genie.url);
    await unlock(b, genie);
    const before = genie.setupCode();
    await genie.restart();
    expect(genie.setupCode()).not.toBe(before);
    const res = await b.post('/api/setup/discord', credentials);
    expect(res.json()).toMatchObject({ statusCode: 403, data: { code: 'setup_locked' } });
  });
});

describe('login before the Discord application is stored', () => {
  it('sends the browser to the wizard', async () => {
    const res = await browser(genie.url).get('/auth/discord');
    expect(res.status).toBe(302);
    expect(res.location).toBe('/setup');
  });
});

describe('readiness', () => {
  it('answers 503 once the database file is gone, while liveness stays up', async () => {
    rmSync(genie.dataDir.databasePath);
    expect((await fetch(`${genie.url}/readyz`)).status).toBe(503);
    expect((await fetch(`${genie.url}/healthz`)).status).toBe(200);
  });
});
