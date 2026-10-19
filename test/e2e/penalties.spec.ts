/// <reference lib="dom" />
// DOM types for the code these tests run in the page to measure the table.
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
  await expect(page.locator('[data-penalty="1"]')).toContainText('Posted');

  // Correct the first one's severity, void the second.
  await page.locator('[data-penalty="1"]').getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Severity').selectOption({ label: 'Major' });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('[data-penalty="1"]')).toContainText('Major');
  await page.locator('[data-penalty="2"]').getByRole('button', { name: 'Void' }).click();
  await page.getByLabel('Reason').fill('duplicate');
  await page.getByRole('button', { name: 'Void penalty' }).click();
  await expect(page.locator('[data-penalty="2"]')).toContainText('Voided');

  // The files the head judge submits.
  const csv = await downloaded(page, 'Download CSV');
  expect(csv).toBe("Tournament ID,Round of Issue,Judge Player ID,Competitor's Player ID,Category,Severity,Penalty,Notes\n26-10-000777,2,0031415,0042,Game Play,Major,Warning,first\n");
  const voided = await downloaded(page, 'Download voided CSV');
  expect(voided.split('\n')[1]).toBe('26-10-000777,3,0031415,0043,Game Play,Minor,Warning,second');

  // The judge leaves the event; a correction keeps them as the judge of record.
  await must(api.put(`/api/days/${day.id}/staff`, { data: { staff: [] } }), 200);
  await page.reload();
  await page.locator('[data-penalty="1"]').getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByLabel('Judge')).toHaveValue(String(judge.id));
  await page.getByLabel('Round').fill('4');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('[data-penalty="1"]')).toContainText('Oak (0031415)');
  expect(await downloaded(page, 'Download CSV')).toContain('26-10-000777,4,0031415,0042,Game Play,Major,Warning,first');
});

/**
 * Where an element's rendered text sits, from the boxes of its text, so padding and wrapping show as they render.
 * Playwright can't pass a function into the page, so callers send its source and rebuild it there.
 */
interface TextBox {
  left: number;
  right: number;
  top: number;
  lines: number;
}
const textBox = (el: Element): TextBox => {
  const range = document.createRange();
  range.selectNodeContents(el);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0);
  return {
    left: Math.min(...rects.map((r) => r.left)),
    right: Math.max(...rects.map((r) => r.right)),
    top: Math.min(...rects.map((r) => r.top)),
    lines: new Set(rects.map((r) => Math.round(r.top))).size,
  };
};

test('the penalties table is readable on a desktop and on a phone', async ({ page, request }) => {
  await ensureSetup(page, request);
  await page.context().clearCookies();
  await login(page, request, IDS.owner);
  await expect(page).toHaveURL(/\/$/);

  // A day with two events: PC with three penalties (a long note, a voided one, a note with no spaces), Juniors with none.
  const api = page.request;
  const must = async <T>(reply: Promise<APIResponse>, status: number): Promise<T> => {
    const r = await reply;
    expect(r.status(), await r.text()).toBe(status);
    return (await r.json().catch(() => null)) as T;
  };
  // The owner, because plan-open.spec.ts adds the plain member as a new staff member later in the run.
  const judge = await must<{ id: number }>(api.post('/api/staff', { data: { displayName: 'Juniper', discordUserId: IDS.owner, playerId: '0027182' } }), 201);
  const { day } = await must<{ day: { id: number } }>(api.post('/api/days', { data: { date: '2026-10-31', title: 'Readable Saturday' } }), 201);
  const event = await must<{ id: number }>(api.post(`/api/days/${day.id}/events`, { data: { name: 'PC', game: 'tcg', startTime: '10:00', tournamentId: '26-10-000779' } }), 201);
  await must(api.post(`/api/days/${day.id}/events`, { data: { name: 'Juniors', game: 'tcg', startTime: '11:00', tournamentId: '26-10-000780' } }), 201);
  await must(api.put(`/api/days/${day.id}/staff`, { data: { staff: [{ staffMemberId: judge.id, events: [{ eventId: event.id, role: 'judge' }] }] } }), 200);
  await must(api.post(`/api/days/${day.id}/open`), 202);
  await opened(page, day.id);

  const { events } = await must<{ events: { id: number; options: { categories: { id: number }[]; types: { id: number }[] } }[] }>(api.get(`/api/days/${day.id}/penalties`), 200);
  const { options } = events.find((e) => e.id === event.id)!;
  const record = (round: number, notes: string) =>
    must<{ penalty: { id: number; revision: number } }>(
      api.post(`/api/days/${day.id}/penalties`, {
        data: {
          idempotencyKey: crypto.randomUUID(),
          eventId: event.id,
          round,
          competitorPlayerId: `00${4200 + round}`,
          categoryId: options.categories[0]!.id,
          severity: 'Minor',
          penaltyTypeId: options.types[0]!.id,
          notes,
          judgeStaffMemberId: judge.id,
        },
      }),
      201,
    );
  await record(1, 'Drew an extra card at the start of the turn; the opponent noticed it straight away and called a judge.');
  const second = await record(2, 'Slow play');
  await record(3, 'x'.repeat(300));
  await must(api.post(`/api/days/${day.id}/penalties/${second.penalty.id}/void`, { data: { revision: second.penalty.revision, reason: 'duplicate' } }), 200);

  // On a desktop.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/days/${day.id}/penalties`);
  const first = page.locator('[data-penalty="1"]');
  await expect(first).toContainText('Posted');
  await page.evaluate(() => document.fonts.ready);

  // Header and values don't run together, and every cell starts at the top of its row.
  const headers = await page.locator('thead th').evaluateAll((ths, box) => ths.filter((th) => th.textContent!.trim()).map((th) => new Function('return ' + box)()(th) as TextBox), textBox.toString());
  for (let i = 1; i < headers.length; i++) expect(headers[i]!.left - headers[i - 1]!.right).toBeGreaterThanOrEqual(12);
  const cells = await first.locator('td').evaluateAll((tds, box) => tds.map((td) => new Function('return ' + box)()(td) as TextBox), textBox.toString());
  const [number, round, competitor, , severity, , notes, , recorded, , card] = cells;
  expect(round!.left - number!.right).toBeGreaterThanOrEqual(12);
  expect(Math.abs(round!.top - number!.top)).toBeLessThanOrEqual(4);
  expect(Math.abs(notes!.top - number!.top)).toBeLessThanOrEqual(4);
  expect(notes!.lines).toBeGreaterThan(1);
  for (const short of [number, round, competitor, severity, recorded, card]) expect(short!.lines).toBe(1);
  const buttonTops = await first.getByRole('button', { name: /^(Edit|Void)$/ }).evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect().top));
  expect(new Set(buttonTops).size).toBe(1);

  // A note with no spaces wraps inside its cell instead of widening the table.
  const unbroken = await page.locator('[data-penalty="3"] td').nth(6).evaluate((td, box) => new Function('return ' + box)()(td) as TextBox, textBox.toString());
  expect(unbroken.right - unbroken.left).toBeLessThanOrEqual(512);
  expect(unbroken.lines).toBeGreaterThan(1);

  // State and card in words; a voided row is muted, not struck through.
  await expect(first).toContainText('Active');
  const voided = page.locator('[data-penalty="2"]');
  await expect(voided).toContainText('Voided');
  await expect(voided).toContainText('Reason: duplicate');
  const decorations = await voided.locator('td, td *').evaluateAll((els) => els.map((el) => getComputedStyle(el).textDecorationLine));
  expect(decorations).not.toContain('line-through');

  // The history reads as part of its penalty: indented and shaded.
  await first.getByRole('button', { name: '1' }).click();
  const history = page.getByRole('listitem').filter({ hasText: 'Revision 1:' });
  await expect(history).toBeVisible();
  const historyCell = page.locator('td', { has: history });
  await expect(historyCell).toHaveClass(/bg-muted/);
  expect((await history.boundingBox())!.x).toBeGreaterThan(number!.left + 8);

  // This page gets the wide column; the day page keeps the narrow one.
  expect((await page.locator('main').boundingBox())!.width).toBeGreaterThan(1000);
  await page.goto(`/days/${day.id}`);
  expect((await page.locator('main').boundingBox())!.width).toBeLessThanOrEqual(768);

  // On a phone, only the table scrolls sideways, also for an event with no penalties.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/days/${day.id}/penalties`);
  await expect(first).toBeVisible();
  const region = page.getByRole('region', { name: 'Penalties' });
  const pageScrolls = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(await pageScrolls()).toBe(false);
  expect(await region.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'Juniors' }).click();
  await expect(page.getByText('No penalties yet.')).toBeVisible();
  expect(await pageScrolls()).toBe(false);
});
