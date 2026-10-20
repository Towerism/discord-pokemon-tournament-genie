/**
 * `sendDirectMessage` against real Discord (issue #51): run by a person before each release (`pnpm test:contract:discord`),
 * never in CI. Without the env vars, every case is skipped.
 *
 * Env (test-guild-only values; never commit them):
 *   GENIE_CONTRACT_BOT_TOKEN, and GENIE_CONTRACT_DM_USER_ID: a member of the test guild who accepts DMs from its
 *   members. They receive one DM per run.
 */
import { silentLogger } from '@towerism/selfhost-kit';
import { describe, expect, it } from 'vitest';
import { createDiscordJs } from '../../server/modules/discord/adapters/discordjs';

const token = process.env.GENIE_CONTRACT_BOT_TOKEN;
const userId = process.env.GENIE_CONTRACT_DM_USER_ID;

if (!token || !userId) {
  describe('direct-message contract: discord.js adapter', () => {
    it.skip('skipped: set GENIE_CONTRACT_BOT_TOKEN and GENIE_CONTRACT_DM_USER_ID to run it against Discord', () => {});
  });
} else {
  const gateway = createDiscordJs({ apiUrl: 'https://discord.com/api', logger: silentLogger })(token).gateway;

  describe('direct-message contract: discord.js adapter', () => {
    it('delivers a DM to a member who accepts them', async () => {
      expect(await gateway.sendDirectMessage(userId, 'Tournament Genie contract test: you can ignore this message.\n\nLink: https://example.com/')).toBe('sent');
    });

    // Whichever of 10013 and 50033 Discord answers for an ID no account has, the adapter maps it to unknown_user.
    it('answers unknown_user for an ID no account has', async () => {
      expect(await gateway.sendDirectMessage('1', 'Tournament Genie contract test.')).toBe('unknown_user');
    });
  });
}
