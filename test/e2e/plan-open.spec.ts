import { type APIRequestContext, type Page, expect, test } from '@playwright/test';
import { BOT_TOKEN, CLIENT_SECRET, IDS } from '../support/discord-world';

// The second critical journey of architecture §11: plan a day, open it, and see its channels.

/** Logs the browser in as `userId` through the fake Discord consent. */
async function login(page: Page, request: APIRequestContext, userId: string) {
  await request.post(`${process.env.FAKE_DISCORD_URL}/_test/login-as`, { data: { userId } });
  await page.goto('/login');
  await page.getByRole('link', { name: 'Log in with Discord' }).click();
  await page.getByRole('link', { name: 'Authorize' }).click();
}

/** Finishes setup through the API when the first-run journey hasn't (so this spec runs alone too). */
async function ensureSetup(page: Page, request: APIRequestContext) {
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

/** Waits on the job through the API, never on a timeout. */
async function jobDone(page: Page, dayId: string) {
  await expect
    .poll(async () => ((await (await page.request.get(`/api/days/${dayId}`)).json()) as { latestJob: { state: string } | null }).latestJob?.state, { timeout: 30_000 })
    .toMatch(/^(succeeded|failed)$/);
  return ((await (await page.request.get(`/api/days/${dayId}`)).json()) as { latestJob: { state: string; error: string | null } }).latestJob;
}

test('an organizer plans a day, opens it, and a head judge finds it', async ({ page, request, browser }) => {
  await ensureSetup(page, request);
  await page.context().clearCookies();
  await login(page, request, IDS.owner);
  await expect(page).toHaveURL(/\/$/);

  // A staff member from the member picker.
  await page.getByRole('link', { name: 'Staff' }).click();
  await page.getByLabel('Find a server member').fill('user0003');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'Use for a new staff member' }).click();
  await expect(page.getByLabel('Display name')).toHaveValue('user0003');
  await page.getByRole('button', { name: 'Add staff member' }).click();
  await expect(page.locator('[data-staff="user0003"]')).toContainText('linked');

  // A day with one event and that staffer as its head judge.
  await page.getByRole('link', { name: 'Days' }).click();
  await page.getByLabel('Date').fill('2026-10-17');
  await page.getByLabel('Title').fill('October LC');
  await page.getByRole('button', { name: 'Create day' }).click();
  await expect(page).toHaveURL(/\/days\/\d+$/);
  const dayId = page.url().split('/').at(-1)!;

  await page.getByLabel('Event name').fill('LC');
  await page.getByRole('button', { name: 'Add event' }).click();
  await expect(page.getByRole('cell', { name: 'lc', exact: true })).toBeVisible();
  await page.getByLabel('Add staff').selectOption({ label: 'user0003' });
  await page.getByLabel("user0003's role in LC").selectOption({ label: 'Head judge' });
  await page.getByRole('button', { name: 'Save staff' }).click();

  // The preview shows the channel and who can see it.
  await expect(page.locator('[data-channel="lc-floor"]')).toContainText('user0003');
  await expect(page.locator('[data-channel="head-judges"]')).toContainText('user0003');

  await page.getByRole('button', { name: 'Open the day' }).click();
  expect(await jobDone(page, dayId)).toMatchObject({ state: 'succeeded' });
  await page.reload();
  await expect(page.getByTestId('job-state')).toContainText('provision: succeeded');
  await expect(page.getByTestId('provisioned-channel')).toHaveCount(4);
  await expect(page.getByText('Discord matches the plan.')).toBeVisible();

  // The head judge logs in and finds the day on their home page.
  const context = await browser.newContext();
  const judge = await context.newPage();
  await login(judge, request, IDS.member);
  await expect(judge).toHaveURL(/\/$/);
  await expect(judge.getByRole('link', { name: 'October LC' })).toBeVisible();
  await expect(judge.getByRole('link', { name: 'Staff' })).toHaveCount(0);
  await judge.getByRole('link', { name: 'October LC' }).click();
  await expect(judge.locator('[data-channel="lc-floor"]')).toBeVisible();
  await expect(judge.getByRole('button', { name: 'Sync' })).toBeVisible();
  await expect(judge.getByRole('button', { name: 'Add event' })).toHaveCount(0);
  await context.close();
});
