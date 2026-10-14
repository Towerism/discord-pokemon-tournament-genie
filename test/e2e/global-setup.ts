import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { RECORDED_FIXTURE_PATH } from '../contract/attendance-source';
import { storeWorld } from '../support/discord-world';
import { startFakeAttendanceHttp } from '../support/fake-attendance-http';
import { startFakeDiscordHttp } from '../support/fake-discord-http';
import { startGenie } from '../support/genie-process';
import { E2E_PORT } from '../../playwright.config';

/** The integration token the fake attendance accepts (a test value, attendance's format). */
export const E2E_ATTENDANCE_TOKEN = `ppa_int_${'e'.repeat(39)}2e2e`;

/**
 * The built app on a fresh data dir, against the HTTP fake of Discord. The setup code is read from the app's
 * log, as an operator would, and handed to the tests.
 */
export default async function globalSetup() {
  if (!(process.env.TEST_SKIP_BUILD === '1' && existsSync('.output/launcher.mjs'))) {
    execFileSync('pnpm', ['build'], { stdio: 'inherit' });
  }
  const discord = await startFakeDiscordHttp(storeWorld());
  // Attendance: the recorded day, with Brock Cup's game unknown and one professor who couldn't be read.
  const attendance = await startFakeAttendanceHttp({ token: E2E_ATTENDANCE_TOKEN });
  const day = JSON.parse(readFileSync(RECORDED_FIXTURE_PATH, 'utf8')) as {
    tournaments: { id: string; game: string | null }[];
    professors: unknown[];
  };
  day.tournaments.find((t) => t.id === 'brocks')!.game = null;
  day.professors.push({ playerId: '5556667', name: 'Prof. Elm', status: 'unread', reason: 'needs_reconnect' });
  attendance.raw.set('2026-10-14', day);
  const genie = await startGenie({ discordUrl: discord.url, port: E2E_PORT });
  process.env.GENIE_SETUP_CODE = genie.setupCode();
  process.env.FAKE_DISCORD_URL = discord.url;
  process.env.FAKE_ATTENDANCE_URL = attendance.url;
  return async () => {
    writeFileSync('test-results/genie-server.log', genie.log());
    await genie.stop();
    await discord.close();
    await attendance.close();
  };
}
