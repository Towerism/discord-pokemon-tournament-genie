import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zonedInstant } from '../../shared/time';
import { IDS, storeWorld } from '../support/discord-world';
import { type FakeDiscordHttp, startFakeDiscordHttp } from '../support/fake-discord-http';
import { completeSetup, loginThroughDiscord } from '../support/flows';
import { type Genie, bootRefused, startGenie } from '../support/genie-process';
import { type Reply, browser } from '../support/http-client';

const ok = (r: Reply, status = 200) => {
  expect(r.status, r.text).toBe(status);
  return r.json<Record<string, unknown>>();
};

describe('with TZ blank, as Unraid sends an empty Timezone field', () => {
  let discord: FakeDiscordHttp;
  let genie: Genie;

  beforeAll(async () => {
    discord = await startFakeDiscordHttp(storeWorld());
    genie = await startGenie({ discordUrl: discord.url, env: { TZ: '' } });
  });
  afterAll(async () => {
    await genie?.stop();
    await discord?.close();
  });

  it('boots in Central time and says so', () => {
    expect(genie.log()).toContain('Store time zone: America/Chicago (default; set TZ to change it)');
  });

  it('adds an event at its Central start time', async () => {
    await completeSetup(browser(genie.url), genie, discord);
    const organizer = browser(genie.url);
    expect((await loginThroughDiscord(organizer, discord, IDS.organizer)).location).toBe('/');
    const { day } = ok(await organizer.post('/api/days', { date: '2026-10-17', title: 'October LC' }), 201) as { day: { id: number } };

    ok(await organizer.post(`/api/days/${day.id}/events`, { name: 'LC', game: 'tcg', startTime: '10:00' }), 201);

    const { events } = ok(await organizer.get(`/api/days/${day.id}`)) as { events: { startTime: string; startsAt: number }[] };
    expect(events).toEqual([expect.objectContaining({ startTime: '10:00', startsAt: zonedInstant('2026-10-17', '10:00', 'America/Chicago') })]);
  });
});

describe('with an unknown TZ', () => {
  it('refuses to boot, naming the value', async () => {
    const { exitCode, log } = await bootRefused({ TZ: 'America/Chicgo' });
    expect(exitCode).toBe(1);
    expect(log).toContain('TZ must be an IANA time zone like America/Chicago (got "America/Chicgo")');
  }, 45_000); // above bootRefused's own 30 s deadline, so a boot that never exits fails with its log
});
