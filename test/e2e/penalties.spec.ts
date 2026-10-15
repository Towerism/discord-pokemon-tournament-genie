import { readFileSync } from 'node:fs';
import { type APIResponse, type Page, expect, test } from '@playwright/test';
import { IDS } from '../support/discord-world';
import { ensureSetup, login } from './support';

// M4's critical journey: record penalties on the website, correct them, and download the CSV the head judge submits.

/** Waits on the job through the API, never on a timeout. */
async function opened(page: Page, dayId: number) {
  await expect
    .poll(async () => ((await (await page.request.get(`/api/days/${dayId}`)).json()) as { latestJob: { state: string } | null }).latestJob?.state, { timeout: 30_000 })
    .toBe('succeeded');
}

async function downloaded(page: Page, button: string): Promise<string> {
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: button }).click()]);
  return readFileSync((await file.path())!, 'utf8');
}

test('a head judge records penalties, corrects one, voids one, and downloads the CSV', async ({ page, request }) => {
  await ensureSetup(page, request);
  await page.context().clearCookies();
  await login(page, request, IDS.owner);
  await expect(page).toHaveURL(/\/$/);

  // The plan, through the API: the organizer as the judge (a player ID), one TCG event with its Tournament ID, opened.
  const api = page.request;
  const must = async <T>(reply: Promise<APIResponse>, status: number): Promise<T> => {
    const r = await reply;
    expect(r.status(), await r.text()).toBe(status);
    return (await r.json().catch(() => null)) as T;
  };
  const judge = await must<{ id: number }>(api.post('/api/staff', { data: { displayName: 'Oak', discordUserId: IDS.organizer, playerId: '0031415' } }), 201);
  const { day } = await must<{ day: { id: number } }>(api.post('/api/days', { data: { date: '2026-10-24', title: 'Penalty Saturday' } }), 201);
  const event = await must<{ id: number }>(api.post(`/api/days/${day.id}/events`, { data: { name: 'PC', game: 'tcg', startTime: '10:00', tournamentId: '26-10-000777' } }), 201);
  await must(api.put(`/api/days/${day.id}/staff`, { data: { staff: [{ staffMemberId: judge.id, events: [{ eventId: event.id, role: 'judge' }] }] } }), 200);
  await must(api.post(`/api/days/${day.id}/open`), 202);
  await opened(page, day.id);

  // The catalog is in Settings.
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Penalty catalog' })).toBeVisible();
  await expect(page.getByTestId('current-season')).toContainText('2026-27');

  // From the day page to its penalties.
  await page.goto(`/days/${day.id}`);
  await page.getByRole('link', { name: 'Penalties' }).click();
  await expect(page).toHaveURL(new RegExp(`/days/${day.id}/penalties$`));
  await expect(page.getByText('Opening and saving it in Excel strips leading zeros')).toBeVisible();

  const record = async (round: string, competitor: string, notes: string) => {
    await page.getByRole('button', { name: 'Add penalty' }).click();
    await page.getByLabel('Judge').selectOption({ label: 'Oak (0031415)' });
    await page.getByLabel('Round').fill(round);
    await page.getByLabel("Competitor's player ID").fill(competitor);
    await page.getByLabel('Category').selectOption({ label: 'Game Play' });
    await page.getByLabel('Severity').selectOption({ label: 'Minor' });
    await page.getByLabel('Penalty', { exact: true }).selectOption({ label: 'Warning' });
    await page.getByLabel('Notes').fill(notes);
    await page.getByRole('button', { name: 'Record penalty' }).click();
  };
  await record('2', '0042', 'first');
  await expect(page.locator('[data-penalty="1"]')).toContainText('0042');
  await record('3', '0043', 'second');
  await expect(page.locator('[data-penalty="2"]')).toContainText('0043');
  await expect(page.locator('[data-penalty="1"]')).toContainText('posted');

  // Correct the first one's severity, void the second.
  await page.locator('[data-penalty="1"]').getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Severity').selectOption({ label: 'Major' });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('[data-penalty="1"]')).toContainText('Major');
  await page.locator('[data-penalty="2"]').getByRole('button', { name: 'Void' }).click();
  await page.getByLabel('Reason').fill('duplicate');
  await page.getByRole('button', { name: 'Void penalty' }).click();
  await expect(page.locator('[data-penalty="2"]')).toContainText('voided');

  // The files the head judge submits.
  const csv = await downloaded(page, 'Download CSV');
  expect(csv).toBe("Tournament ID,Round of Issue,Judge Player ID,Competitor's Player ID,Category,Severity,Penalty,Notes\n26-10-000777,2,0031415,0042,Game Play,Major,Warning,first\n");
  const voided = await downloaded(page, 'Download voided CSV');
  expect(voided.split('\n')[1]).toBe('26-10-000777,3,0031415,0043,Game Play,Minor,Warning,second');
});
