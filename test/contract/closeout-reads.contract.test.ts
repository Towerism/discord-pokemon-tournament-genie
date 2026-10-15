/**
 * Close-out's reads against the discord.js adapter on the owner's test guild (architecture §11, the M5 spec): history
 * paging, the newest message, thread listing and attachment re-resolution, in a throwaway channel the bot creates
 * and deletes. Run by a person before a release (`pnpm test:contract:discord`), never in CI; skipped without the env.
 * Thread kinds and an expired CDN URL are on the manual smoke checklist: the port can't create threads or uploads.
 *
 * Env (test-guild-only values; never commit them): GENIE_CONTRACT_BOT_TOKEN, GENIE_CONTRACT_GUILD_ID.
 */
import { randomUUID } from 'node:crypto';
import { silentLogger } from '@towerism/selfhost-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiscordJs } from '../../server/modules/discord/adapters/discordjs';
import type { DiscordGateway } from '../../server/modules/discord/port';

const token = process.env.GENIE_CONTRACT_BOT_TOKEN;
const guildId = process.env.GENIE_CONTRACT_GUILD_ID;

if (!token || !guildId) {
  describe('close-out reads: discord.js adapter', () => {
    it.skip('skipped: set GENIE_CONTRACT_BOT_TOKEN and GENIE_CONTRACT_GUILD_ID to run it on a test guild', () => {});
  });
} else {
  describe('close-out reads: discord.js adapter (test guild)', () => {
    const bot: DiscordGateway = createDiscordJs({ apiUrl: 'https://discord.com/api', logger: silentLogger })(token).gateway;
    const run = randomUUID().slice(0, 8);
    let category = '';
    let channel = '';
    const posted: string[] = [];

    beforeAll(async () => {
      category = await bot.createCategory(guildId, { name: `genie-contract-${run}`, overwrites: [] });
      channel = await bot.createChannel(guildId, { name: `closeout-${run}`, parentId: category });
      for (let i = 0; i < 105; i++) posted.push(await bot.postMessage(channel, { content: `message ${i}` }));
    }, 120_000);
    afterAll(async () => {
      if (channel) await bot.deleteChannel(channel, 'contract run');
      if (category) await bot.deleteChannel(category, 'contract run');
    });

    it('pages history 100 at a time, newest first, and answers the newest message', async () => {
      const first = (await bot.readHistory(channel))!;
      expect(first).toHaveLength(100);
      expect(first[0]!.id).toBe(posted.at(-1));
      const second = (await bot.readHistory(channel, first.at(-1)!.id))!;
      expect(second.map((m) => m.id)).toEqual(posted.slice(0, 5).reverse());
      expect(await bot.readHistory(channel, second.at(-1)!.id)).toEqual([]);
      expect(await bot.getLatestMessageId(channel)).toBe(posted.at(-1));
    });

    it('lists the channel’s threads without an error (Manage Threads held)', async () => {
      expect(await bot.listThreads(guildId, channel)).toEqual([]);
    });

    it('answers not_found for an attachment a message lacks, and message_deleted once it is gone', async () => {
      const id = posted[0]!;
      expect(await bot.resolveAttachment(channel, id, '1')).toEqual({ error: 'not_found' });
      await bot.deleteMessage(channel, id);
      expect(await bot.resolveAttachment(channel, id, '1')).toEqual({ error: 'message_deleted' });
    });

    it('answers null for an empty channel and gone for a deleted one', async () => {
      const empty = await bot.createChannel(guildId, { name: `empty-${run}`, parentId: category });
      expect(await bot.getLatestMessageId(empty)).toBeNull();
      await bot.deleteChannel(empty, 'contract run');
      expect(await bot.getLatestMessageId(empty)).toBe('gone');
      expect(await bot.readHistory(empty)).toBeNull();
    });
  });
}
