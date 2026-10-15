import { type APIResponse, type Page, expect, test } from '@playwright/test';
import { IDS } from '../support/discord-world';
import { ensureSetup, login } from './support';

// Editing a staff member's display name and player ID from the Staff page. The rules (trimming, limits, uniqueness)
// are pinned in the server and directory suites; this journey checks what only the page does.

const row = (page: Page, name: string) => page.locator(`[data-staff="${name}"]`);

test('an organizer edits, clears, cancels and is refused on the Staff page', async ({ page, request }, info) => {
  await ensureSetup(page, request);
  await page.context().clearCookies();
  await login(page, request, IDS.owner);
  await expect(page).toHaveURL(/\/$/);

  // Members of this spec only: names and player IDs nothing else uses, distinct per attempt, since a retry or a
  // --repeat-each run shares the app and its data with the attempt before.
  const run = `${info.retry}${info.repeatEachIndex}`;
  const [editMe, edited, clearMe, holder] = ['Edit Me', 'Edited Person', 'Clear Me', 'Holder'].map((n) => `${n} ${run}`) as [string, string, string, string];
  const pid = (n: number) => `028${run}0${n}`;
  const api = page.request;
  const must = async (reply: Promise<APIResponse>) => expect((await reply).status()).toBe(201);
  await must(api.post('/api/staff', { data: { displayName: editMe } }));
  await must(api.post('/api/staff', { data: { displayName: clearMe, playerId: pid(2) } }));
  await must(api.post('/api/staff', { data: { displayName: holder, playerId: pid(3) } }));

  const patches: unknown[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/api/staff/')) patches.push(r.postDataJSON());
  });

  await page.getByRole('link', { name: 'Staff' }).click();
  // The layout has its own status and alert banners; the page's are in main.
  const main = page.getByRole('main');

  // Both fields, saved with Enter; the player ID keeps its leading zero.
  await row(page, editMe).getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel(`Display name for ${editMe}`).fill(edited);
  await page.getByLabel(`Player ID for ${editMe}`).fill(pid(1));
  await page.getByLabel(`Player ID for ${editMe}`).press('Enter');
  await expect(row(page, edited)).toContainText(pid(1));
  await expect(main.getByRole('status')).toHaveText('Saved.');
  await expect(page.getByLabel(`Display name for ${editMe}`)).toHaveCount(0);
  expect(patches).toEqual([{ displayName: edited, playerId: pid(1) }]);
  const listed = (await (await api.get('/api/staff')).json()) as { staff: { displayName: string; playerId: string | null }[] };
  expect(listed.staff).toContainEqual(expect.objectContaining({ displayName: edited, playerId: pid(1) }));

  // An emptied player ID is sent as null.
  await row(page, clearMe).getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel(`Player ID for ${clearMe}`).fill('');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(row(page, clearMe).locator('td').nth(1)).toHaveText('—');
  expect(patches.at(-1)).toEqual({ displayName: clearMe, playerId: null });

  // Cancel sends nothing and keeps the old values.
  const before = patches.length;
  await row(page, holder).getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel(`Display name for ${holder}`).fill('Not Saved');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByLabel(`Display name for ${holder}`)).toHaveCount(0);
  await expect(row(page, holder)).toContainText(pid(3));
  expect(patches.length).toBe(before);

  // One editor at a time: opening another row closes the first without saving.
  await row(page, holder).getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel(`Display name for ${holder}`).fill('Not Saved Either');
  await row(page, clearMe).getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByLabel(`Display name for ${holder}`)).toHaveCount(0);
  await expect(page.getByLabel(`Display name for ${clearMe}`)).toBeVisible();
  await expect(row(page, holder)).toBeVisible();
  expect(patches.length).toBe(before);

  // Refusals keep the editor and what was typed: a taken player ID (409), then a blank name (400).
  await page.getByLabel(`Player ID for ${clearMe}`).fill(pid(3));
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(main.getByRole('alert')).toContainText('Another staff member has that player ID.');
  await expect(page.getByLabel(`Player ID for ${clearMe}`)).toHaveValue(pid(3));
  await page.getByLabel(`Display name for ${clearMe}`).fill('   ');
  await page.getByLabel(`Player ID for ${clearMe}`).fill(pid(4));
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(main.getByRole('alert')).toContainText('The request body is invalid.');
  await expect(page.getByLabel(`Display name for ${clearMe}`)).toHaveValue('   ');
  await expect(page.getByLabel(`Player ID for ${clearMe}`)).toHaveValue(pid(4));
  const stored = (await (await api.get('/api/staff')).json()) as { staff: { displayName: string; playerId: string | null }[] };
  expect(stored.staff).toContainEqual(expect.objectContaining({ displayName: clearMe, playerId: null }));
});
