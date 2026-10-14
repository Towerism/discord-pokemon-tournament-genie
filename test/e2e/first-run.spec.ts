import { expect, test } from '@playwright/test';
import { BOT_TOKEN, CLIENT_SECRET, IDS } from '../support/discord-world';

// The critical journey of architecture §11: first-run setup, including the owner's login inside the wizard,
// against a fake Discord.
test('an organizer sets up Genie from the container log to the signed-in home page', async ({ page, request }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);

  await page.getByLabel('Setup code').fill(process.env.GENIE_SETUP_CODE!);
  await page.getByRole('button', { name: 'Unlock' }).click();

  await page.getByLabel('Bot token').fill(BOT_TOKEN);
  await page.getByLabel('Client ID').fill(IDS.app);
  await page.getByLabel('Client secret').fill(CLIENT_SECRET);
  await page.getByRole('button', { name: 'Save application' }).click();
  await expect(page.locator('[data-check="token_valid"]')).toHaveAttribute('data-ok', 'true');
  await expect(page.getByRole('link', { name: 'Invite the bot to your server' })).toHaveAttribute('href', /permissions=397553028176/);

  await page.getByRole('button', { name: 'Load servers' }).click();
  await page.getByLabel('Server').selectOption({ label: 'Pallet Town Games' });
  await page.getByRole('button', { name: 'Use this server' }).click();
  await expect(page.getByText('Server: Pallet Town Games')).toBeVisible();

  await request.post(`${process.env.FAKE_DISCORD_URL}/_test/login-as`, { data: { userId: IDS.owner } });
  await page.getByRole('link', { name: 'Log in with Discord' }).click();
  await page.getByRole('link', { name: 'Authorize' }).click();
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByText(`Owner: Discord user ${IDS.owner}.`)).toBeVisible();

  await page.getByLabel('Organizer role').selectOption({ label: 'Organizer' });
  await page.getByLabel('Head judge role').selectOption({ label: 'Head judge' });
  await page.getByRole('button', { name: 'Save roles' }).click();
  await expect(page.locator('[data-check="bot_role_above_mapped_roles"]')).toHaveAttribute('data-ok', 'true');

  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('Signed in as User 0001.')).toBeVisible();

  await page.goto('/setup');
  await expect(page).toHaveURL(/\/$/);
});
