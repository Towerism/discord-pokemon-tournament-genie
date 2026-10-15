import { type Page, expect, test } from '@playwright/test';
import { IDS } from '../support/discord-world';
import { ensureSetup, login } from './support';

// The second critical journey of architecture §11: plan a day, open it, see its channels, then close it, download
// its exports and purge it.

/** Waits on the job through the API, never on a timeout. */
async function jobDone(page: Page, dayId: string) {
  await expect
    .poll(async () => ((await (await page.request.get(`/api/days/${dayId}`)).json()) as { latestJob: { state: string } | null }).latestJob?.state, { timeout: 30_000 })
    .toMatch(/^(succeeded|failed)$/);
  return ((await (await page.request.get(`/api/days/${dayId}`)).json()) as { latestJob: { state: string; error: string | null } }).latestJob;
}

/** Waits on the day's state through the API, never on a timeout. */
async function dayState(page: Page, dayId: string, state: string) {
  await expect
    .poll(async () => ((await (await page.request.get(`/api/days/${dayId}`)).json()) as { day: { state: string } }).day.state, { timeout: 30_000 })
    .toBe(state);
}

test('an organizer plans a day, opens it, a head judge closes it and downloads its exports, and the organizer purges it', async ({ page, request, browser }) => {
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
  await page.getByLabel('Tournament ID').fill('26-10-000123');
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

  // The head judge closes the day; the confirmation names what will be locked.
  await judge.getByRole('button', { name: 'Close the day' }).click();
  await expect(judge.getByRole('alertdialog')).toContainText('Its 4 channels will be locked');
  await judge.getByRole('button', { name: 'Confirm close' }).click();
  await dayState(judge, dayId, 'closed');
  await judge.reload();
  await expect(judge.getByRole('status').filter({ hasText: 'Closed.' })).toBeVisible();
  await judge.getByRole('link', { name: 'Exports' }).click();
  await expect(judge.locator('[data-csv="LC"]')).toBeVisible();
  await expect(judge.locator('[data-transcript="lc-floor"]')).toBeVisible();
  await expect(judge.locator('[data-transcript="lc-penalties"]')).toBeVisible();
  const href = await judge.locator('[data-csv="LC"] a').first().getAttribute('href');
  const csv = await judge.request.get(href!);
  expect(csv.status()).toBe(200);
  expect(csv.headers()['content-type']).toBe('text/csv; charset=utf-8');
  expect((await csv.text()).split('\n')[0]).toBe("Tournament ID,Round of Issue,Judge Player ID,Competitor's Player ID,Category,Severity,Penalty,Notes");
  await judge.goto(`/days/${dayId}/penalties`);
  await expect(judge.getByRole('status').filter({ hasText: 'This day is closed.' })).toBeVisible();
  await expect(judge.getByRole('button', { name: 'Add penalty' })).toHaveCount(0);
  await context.close();

  // The organizer keeps transcripts 120 days, then deletes the channels now.
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByTestId('grace')).toHaveText('7 days');
  await page.getByLabel('Keep transcripts (days)').fill('120');
  await page.getByRole('button', { name: 'Save close-out' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await page.goto(`/days/${dayId}`);
  await page.getByRole('button', { name: 'Delete now' }).click();
  await page.getByRole('button', { name: 'Confirm delete' }).click();
  await dayState(page, dayId, 'purged');
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'Closed and purged' })).toBeVisible();
});
