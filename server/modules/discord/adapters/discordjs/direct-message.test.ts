import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeDiscordHttp, startFakeDiscordHttp } from '../../../../../test/support/fake-discord-http';
import { recordingLogger } from '../../../../../test/support/logger';
import { createFakeDiscord } from '../../fake';
import { DiscordAuthError, DiscordRequestError, DiscordUnavailableError } from '../../port';
import { createDiscordJs } from './index';

const GUILD = '400000000000000001';
const APP = '300000000000000001';
const TOKEN = 'fake-bot-token-direct-message';
const ASH = '100000000000000001';
/** Discord's `SUPPRESS_EMBEDS` message flag. */
const SUPPRESS_EMBEDS = 1 << 2;

describe('the discord.js adapter’s direct messages', () => {
  let http: FakeDiscordHttp;
  let fake: ReturnType<typeof createFakeDiscord>;

  beforeEach(async () => {
    fake = createFakeDiscord();
    fake.addApplication({ id: APP, token: TOKEN });
    fake.addGuild({ id: GUILD, name: 'G' });
    fake.inviteBot(APP, GUILD);
    fake.addMember(GUILD, ASH);
    http = await startFakeDiscordHttp(fake);
  });
  afterEach(() => http.close());

  const gateway = () => createDiscordJs({ apiUrl: `${http.url}/api`, logger: recordingLogger() })(TOKEN).gateway;

  it('opens the DM channel and posts there, with no mentions and no link preview', async () => {
    expect(await gateway().sendDirectMessage(ASH, 'Join us: https://a.example/i/x')).toBe('sent');
    expect(fake.directMessages).toEqual([{ userId: ASH, content: 'Join us: https://a.example/i/x' }]);
    expect(http.directMessageBodies).toEqual([{ content: 'Join us: https://a.example/i/x', allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS }]);
    expect(http.requests.filter((r) => r.startsWith('POST'))).toEqual(['POST /api/users/@me/channels', expect.stringMatching(/^POST \/api\/channels\/\d+\/messages$/)]);
    expect(http.requests.some((r) => r.includes('/guilds/'))).toBe(false);
  });

  it('answers refused for 50007 and unknown_user for 10013 and 50033', async () => {
    http.dmAnswers.push({ status: 403, code: 50007 });
    expect(await gateway().sendDirectMessage(ASH, 'x')).toBe('refused');
    http.dmAnswers.push({ status: 404, code: 10013 });
    expect(await gateway().sendDirectMessage(ASH, 'x')).toBe('unknown_user');
    http.dmAnswers.push({ status: 400, code: 50033 });
    expect(await gateway().sendDirectMessage(ASH, 'x')).toBe('unknown_user');
    expect(fake.directMessages).toEqual([]);
  });

  it('throws the port’s errors for a refused token, a missing permission and an outage', async () => {
    http.dmAnswers.push({ status: 401, code: 0 });
    await expect(gateway().sendDirectMessage(ASH, 'x')).rejects.toBeInstanceOf(DiscordAuthError);
    http.dmAnswers.push({ status: 403, code: 50013 });
    await expect(gateway().sendDirectMessage(ASH, 'x')).rejects.toSatisfy((err) => err instanceof DiscordRequestError && err.code === 50013);
    // discord.js retries a 5xx twice, so the outage lasts three answers.
    http.dmAnswers.push({ status: 500, code: 0 }, { status: 500, code: 0 }, { status: 500, code: 0 });
    await expect(gateway().sendDirectMessage(ASH, 'x')).rejects.toBeInstanceOf(DiscordUnavailableError);
  });
});
