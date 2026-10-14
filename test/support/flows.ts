import { expect } from 'vitest';
import type { FakeDiscordHttp } from './fake-discord-http';
import { BOT_TOKEN, CLIENT_SECRET, IDS } from './discord-world';
import type { Genie } from './genie-process';
import type { Browser, Reply } from './http-client';

/** Logs `browser` in through the fake Discord consent as `userId`; returns Genie's final redirect. */
export async function loginThroughDiscord(browser: Browser, discord: FakeDiscordHttp, userId: string): Promise<Reply> {
  discord.loginAs(userId);
  const start = await browser.get('/auth/discord');
  expect(start.status, start.text).toBe(302);
  const consent = await fetch(start.location!);
  const href = /id="authorize" href="([^"]+)"/.exec(await consent.text())?.[1]?.replace(/&amp;/g, '&');
  if (!href) throw new Error('No consent link on the fake Discord page.');
  const callback = new URL(href);
  return browser.get(callback.pathname + callback.search);
}

export async function unlock(browser: Browser, genie: Genie): Promise<void> {
  const res = await browser.post('/api/setup/unlock', { code: genie.setupCode() });
  expect(res.status, res.text).toBe(204);
}

export const credentials = { botToken: BOT_TOKEN, clientId: IDS.app, clientSecret: CLIENT_SECRET };

/** Runs the whole wizard as the owner; `browser` ends signed in as the owner. */
export async function completeSetup(browser: Browser, genie: Genie, discord: FakeDiscordHttp): Promise<void> {
  await unlock(browser, genie);
  expect((await browser.post('/api/setup/discord', credentials)).status).toBe(200);
  expect((await browser.post('/api/setup/guild', { guildId: IDS.guild })).status).toBe(200);
  expect((await loginThroughDiscord(browser, discord, IDS.owner)).location).toBe('/setup');
  const roles = await browser.post('/api/setup/roles', { organizerRoleId: IDS.organizerRole, headJudgeRoleId: IDS.headJudgeRole });
  expect(roles.status, roles.text).toBe(200);
  const finish = await browser.post('/api/setup/finish');
  expect(finish.status, finish.text).toBe(200);
}

/** No reply body or header, and no log line, may carry a secret. */
export function expectNoSecrets(texts: string[]): void {
  const secrets = [BOT_TOKEN, CLIENT_SECRET];
  for (const text of texts) for (const secret of secrets) expect(text).not.toContain(secret);
}

export const replyTexts = (browser: Browser) => browser.replies.map((r) => `${JSON.stringify(r.headers)}\n${r.text}`);

/** A code an attacker gets from Discord directly, without Genie's state (login CSRF). */
export async function mintCodeOutsideGenie(discord: FakeDiscordHttp, genie: Genie, userId: string): Promise<string> {
  discord.loginAs(userId);
  const redirect = encodeURIComponent(`http://localhost:${genie.port}/auth/discord`);
  const consent = await (await fetch(`${discord.url}/oauth2/authorize?client_id=${IDS.app}&redirect_uri=${redirect}`)).text();
  const href = /id="authorize" href="([^"]+)"/.exec(consent)![1]!.replace(/&amp;/g, '&');
  return new URL(href).searchParams.get('code')!;
}
