import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { storeWorld } from '../support/discord-world';
import { startFakeDiscordHttp } from '../support/fake-discord-http';
import { startGenie } from '../support/genie-process';
import { E2E_PORT } from '../../playwright.config';

/**
 * The built app on a fresh data dir, against the HTTP fake of Discord. The setup code is read from the app's
 * log, as an operator would, and handed to the tests.
 */
export default async function globalSetup() {
  if (!(process.env.TEST_SKIP_BUILD === '1' && existsSync('.output/launcher.mjs'))) {
    execFileSync('pnpm', ['build'], { stdio: 'inherit' });
  }
  const discord = await startFakeDiscordHttp(storeWorld());
  const genie = await startGenie({ discordUrl: discord.url, port: E2E_PORT });
  process.env.GENIE_SETUP_CODE = genie.setupCode();
  process.env.FAKE_DISCORD_URL = discord.url;
  return async () => {
    writeFileSync('test-results/genie-server.log', genie.log());
    await genie.stop();
    await discord.close();
  };
}
