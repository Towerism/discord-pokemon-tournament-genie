import { type APIRequestContext, type Page, expect } from '@playwright/test';
import { BOT_TOKEN, CLIENT_SECRET, IDS } from '../support/discord-world';

/** Logs the browser in as `userId` through the fake Discord consent. */
export async function login(page: Page, request: APIRequestContext, userId: string) {
  await request.post(`${process.env.FAKE_DISCORD_URL}/_test/login-as`, { data: { userId } });
  await page.goto('/login');
  await page.getByRole('link', { name: 'Log in with Discord' }).click();
  await page.getByRole('link', { name: 'Authorize' }).click();
}

/** Finishes setup through the API when the first-run journey hasn't (so a spec runs alone too). */
export async function ensureSetup(page: Page, request: APIRequestContext) {
  if ((await page.request.get('/api/setup')).status() === 410) return;
  const api = page.request;
  expect((await api.post('/api/setup/unlock', { data: { code: process.env.GENIE_SETUP_CODE } })).status()).toBe(204);
  expect((await api.post('/api/setup/discord', { data: { botToken: BOT_TOKEN, clientId: IDS.app, clientSecret: CLIENT_SECRET } })).ok()).toBe(true);
  expect((await api.post('/api/setup/guild', { data: { guildId: IDS.guild } })).ok()).toBe(true);
  await request.post(`${process.env.FAKE_DISCORD_URL}/_test/login-as`, { data: { userId: IDS.owner } });
  await page.goto('/setup');
  await page.getByRole('link', { name: 'Log in with Discord' }).click();
  await page.getByRole('link', { name: 'Authorize' }).click();
  expect((await api.post('/api/setup/roles', { data: { organizerRoleId: IDS.organizerRole, headJudgeRoleId: IDS.headJudgeRole } })).ok()).toBe(true);
  expect((await api.post('/api/setup/finish')).ok()).toBe(true);
}
