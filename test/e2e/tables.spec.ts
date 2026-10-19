/// <reference lib="dom" />
// DOM types for the code these tests run in the page to measure the tables.
import { type APIResponse, type Locator, type Page, expect, test } from '@playwright/test';
import { IDS } from '../support/discord-world';
import { type TextBox, ensureSetup, login, textBox } from './support';

// How the Staff, day plan and Settings tables read: padding between columns, a line under each row, cells that stay
// table cells, and on a phone a box that scrolls instead of the page. The penalties table has its own test.

/** Where the content of each cell sits; a cell with nothing rendered in it is left out. */
const boxes = (cells: Locator): Promise<TextBox[]> =>
  cells
    .evaluateAll((els, box) => els.map((el) => new Function('return ' + box)()(el) as TextBox), textBox.toString())
    .then((all) => all.filter((b) => Number.isFinite(b.left)));

/** Each box ends at least 12 px before the next one starts. */
function expectApart(name: string, all: TextBox[]) {
  expect(all.length, `${name}: cells measured`).toBeGreaterThan(1);
  for (let i = 1; i < all.length; i++) expect(all[i]!.left - all[i - 1]!.right, `${name}: gap before cell ${i + 1}`).toBeGreaterThanOrEqual(12);
}

/** The header row and every body row has a solid line under it, and every cell lays out as a table cell. */
async function expectLinedCells(name: string, rows: Locator) {
  const lines = await rows.evaluateAll((trs) => trs.map((tr) => ({ width: parseFloat(getComputedStyle(tr).borderBottomWidth), style: getComputedStyle(tr).borderBottomStyle })));
  expect(lines.length, `${name}: rows`).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line.style, `${name}: row line style`).toBe('solid');
    expect(line.width, `${name}: row line width`).toBeGreaterThanOrEqual(1);
  }
  const displays = await rows.locator('th, td').evaluateAll((cells) => cells.map((c) => getComputedStyle(c).display));
  expect(new Set(displays), `${name}: cell display`).toEqual(new Set(['table-cell']));
}

/** A table in its named scroll box reads well: header text apart, the given row's values apart, lines, real cells. */
async function expectReadable(page: Page, region: string, row: Locator) {
  const table = page.getByRole('region', { name: region, exact: true }).locator('table');
  expectApart(`${region} header`, await boxes(table.locator('thead th')));
  expectApart(`${region} row`, await boxes(row.locator('td')));
  await expectLinedCells(region, table.locator('tr'));
}

/** At 390 px each named box ends inside the viewport, so a wide table scrolls in its box, not the page. */
async function expectBoxesFit(page: Page, regions: string[]) {
  for (const name of regions) {
    const box = (await page.getByRole('region', { name, exact: true }).boundingBox())!;
    expect(box.x + box.width, `${name} right edge`).toBeLessThanOrEqual(390);
  }
}

test('the Staff, day plan and catalog tables are readable on a desktop and on a phone', async ({ page, request }, info) => {
  await ensureSetup(page, request);
  await page.context().clearCookies();
  await login(page, request, IDS.owner);
  await expect(page).toHaveURL(/\/$/);

  // A draft day with two events and one staff member in a role, and a day with no events. The staff member's name
  // is distinct per attempt and has no player ID, since player IDs are unique and a retry shares the app's data.
  const run = `${info.retry}${info.repeatEachIndex}`;
  const name = `Table Tester ${run}`;
  const api = page.request;
  const must = async <T>(reply: Promise<APIResponse>, status: number): Promise<T> => {
    const r = await reply;
    expect(r.status(), await r.text()).toBe(status);
    return (await r.json().catch(() => null)) as T;
  };
  const staffer = await must<{ id: number }>(api.post('/api/staff', { data: { displayName: name } }), 201);
  const { day } = await must<{ day: { id: number } }>(api.post('/api/days', { data: { date: '2026-11-07', title: `Tables ${run}` } }), 201);
  const event = await must<{ id: number }>(api.post(`/api/days/${day.id}/events`, { data: { name: 'PC', game: 'tcg', startTime: '10:00', tournamentId: '26-11-000901' } }), 201);
  await must(api.post(`/api/days/${day.id}/events`, { data: { name: 'Juniors', game: 'tcg', startTime: '11:00', tournamentId: '26-11-000902' } }), 201);
  await must(api.put(`/api/days/${day.id}/staff`, { data: { staff: [{ staffMemberId: staffer.id, events: [{ eventId: event.id, role: 'judge' }] }] } }), 200);
  const { day: empty } = await must<{ day: { id: number } }>(api.post('/api/days', { data: { date: '2026-11-08', title: `No events ${run}` } }), 201);

  const pages = {
    staff: { url: '/staff', regions: ['Staff table'] },
    plan: { url: `/days/${day.id}`, regions: ['Events table', 'Staff table'] },
    settings: { url: '/settings', regions: ['Categories table', 'Penalties table'] },
  };
  const ownStaffRow = page.locator(`[data-staff="${name}"]`);
  const load = async (url: string, ready: Locator) => {
    await page.goto(url);
    await expect(ready).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
  };
  const firstRow = (region: string) => page.getByRole('region', { name: region, exact: true }).locator('tbody tr').first();
  const planRow = (region: string, text: string) => page.getByRole('region', { name: region, exact: true }).locator('tbody tr', { hasText: text });

  // On a desktop, each page keeps its 768 px column.
  await page.setViewportSize({ width: 1280, height: 800 });
  const narrowColumn = async () => expect((await page.getByRole('main').boundingBox())!.width).toBeLessThanOrEqual(768);

  await load(pages.staff.url, ownStaffRow);
  await expectReadable(page, 'Staff table', ownStaffRow);
  await narrowColumn();

  // The inline edit row keeps its line and its cells.
  await ownStaffRow.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByLabel(`Display name for ${name}`)).toBeVisible();
  await expectLinedCells('Staff table while editing', ownStaffRow);
  await page.getByRole('button', { name: 'Cancel' }).click();

  await load(pages.plan.url, planRow('Events table', 'Juniors'));
  await expectReadable(page, 'Events table', planRow('Events table', 'PC'));
  await expectReadable(page, 'Staff table', planRow('Staff table', name));
  await narrowColumn();

  await load(pages.settings.url, firstRow('Penalties table'));
  await expectReadable(page, 'Categories table', firstRow('Categories table'));
  await expectReadable(page, 'Penalties table', firstRow('Penalties table'));
  await narrowColumn();

  // On a phone, each table's box ends inside the screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await load(pages.staff.url, ownStaffRow);
  await expectBoxesFit(page, pages.staff.regions);
  await load(pages.plan.url, planRow('Events table', 'Juniors'));
  await expectBoxesFit(page, pages.plan.regions);
  await load(pages.settings.url, firstRow('Penalties table'));
  await expectBoxesFit(page, pages.settings.regions);

  // A day with no events still shows both tables in their boxes.
  await load(`/days/${empty.id}`, page.getByRole('region', { name: 'Events table', exact: true }));
  await expectBoxesFit(page, pages.plan.regions);
});
