import { expect, test } from '@playwright/test';
import { IDS } from '../support/discord-world';
import { E2E_ATTENDANCE_TOKEN } from './global-setup';
import { ensureSetup, login } from './support';

// A critical journey of M3 (ADR-0008): connect attendance, import a day, and confirm a game attendance didn't know.

test('an organizer connects attendance and imports a day', async ({ page, request }) => {
  await ensureSetup(page, request);
  await page.context().clearCookies();
  await login(page, request, IDS.owner);
  await expect(page).toHaveURL(/\/$/);

  await page.goto('/settings');
  await page.getByLabel('Attendance address').fill(process.env.FAKE_ATTENDANCE_URL!);
  await page.getByLabel(/Integration token/).fill(E2E_ATTENDANCE_TOKEN);
  await page.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByText(/Connected to/)).toContainText(E2E_ATTENDANCE_TOKEN.slice(-4));
  await expect(page.getByLabel(/Integration token/)).toHaveValue('');

  await page.getByRole('link', { name: 'Days' }).click();
  await page.getByLabel('Date').fill('2026-10-14');
  await page.getByLabel('Title').fill('Wednesday cups');
  await page.getByRole('button', { name: 'Create day' }).click();
  await expect(page).toHaveURL(/\/days\/\d+$/);
  const dayId = page.url().split('/').at(-1)!;

  await page.getByRole('button', { name: 'Import from attendance' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Prof. Elm needs to reconnect in attendance')).toBeVisible();
  await expect(dialog.locator('[data-item="event_added"]')).toHaveCount(2);
  await expect(dialog.getByText(/Add Brock Cup .*game not known/)).toBeVisible();
  await expect(dialog.getByText(/Add Olive Cup/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Accept selected' }).click();

  // Waits on the plan through the API, never on a timeout.
  await expect
    .poll(async () => ((await (await page.request.get(`/api/days/${dayId}`)).json()) as { events: unknown[] }).events.length, { timeout: 15_000 })
    .toBe(2);
  const events = page.getByRole('region', { name: 'Events' });
  await expect(events.getByRole('row', { name: /Brock Cup/ })).toContainText('Brock Harrison');
  await expect(events.getByRole('row', { name: /Olive Cup/ })).toContainText('Olive Oak');
  await expect(page.getByText(/Refreshed from attendance/)).toBeVisible();

  const brock = events.getByRole('row', { name: /Brock Cup/ });
  await expect(brock.getByText('game not confirmed')).toBeVisible();
  await brock.getByLabel('Game of Brock Cup').selectOption('vgc');
  await expect(brock).toContainText('VGC');
  await expect(brock.getByText('game not confirmed')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh from attendance' })).toBeVisible();
});
