/**
 * The S3 table against the discord.js adapter on the owner's test guild (architecture §11, the M2 spec): the
 * adapter writes and reads back, and the resolver computes the effective permissions from what it read. Run by a
 * person before each release (`pnpm test:contract:discord`), never in CI. Without the env vars, every case is skipped.
 *
 * Env (test-guild-only values; never commit them):
 *   GENIE_CONTRACT_BOT_TOKEN, GENIE_CONTRACT_GUILD_ID, GENIE_CONTRACT_SUBJECT_USER_ID,
 *   GENIE_CONTRACT_OTHER_USER_ID (ranked above the bot, W4), GENIE_CONTRACT_ORGANIZER_ROLE_ID,
 *   GENIE_CONTRACT_HIGH_ROLE_ID (above the bot's role, W3), GENIE_CONTRACT_SENDROLE_ID, GENIE_CONTRACT_ADMIN_ROLE_ID,
 *   and optionally GENIE_CONTRACT_ADMIN_TOKEN: a bot with Administrator in the same guild, for the setups S3's
 *   administrator placed (W7). Without it those cases are skipped, with the reason.
 */
import { randomUUID } from 'node:crypto';
import { silentLogger } from '@towerism/selfhost-kit';
import { describe, it } from 'vitest';
import { PERMISSION_BITS } from '../../shared/discord/permissions';
import { effectivePermissions } from '../../shared/discord/resolve';
import { writeRefusal } from '../../shared/discord/write-rules';
import { createDiscordJs } from '../../server/modules/discord/adapters/discordjs';
import type { DiscordGateway } from '../../server/modules/discord/port';
import { type CaseGuild, type EffectiveCase, type PermissionCase, SkipCase, describePermissionContract, loadCases } from './discord-permissions';

const env = (name: string) => process.env[`GENIE_CONTRACT_${name}`];
const REQUIRED = ['BOT_TOKEN', 'GUILD_ID', 'SUBJECT_USER_ID', 'OTHER_USER_ID', 'ORGANIZER_ROLE_ID', 'HIGH_ROLE_ID', 'SENDROLE_ID', 'ADMIN_ROLE_ID'];
const missing = REQUIRED.filter((n) => !env(n));

if (missing.length) {
  describe('S3 permission contract: discord.js adapter', () => {
    it.skip(`skipped: set ${missing.map((n) => `GENIE_CONTRACT_${n}`).join(', ')} to run it on a test guild`, () => {});
  });
} else {
  const guildId = env('GUILD_ID')!;
  const makePort = createDiscordJs({ apiUrl: 'https://discord.com/api', logger: silentLogger });
  const bot = makePort(env('BOT_TOKEN')!).gateway;
  const admin: DiscordGateway | null = env('ADMIN_TOKEN') ? makePort(env('ADMIN_TOKEN')!).gateway : null;
  const runId = randomUUID().slice(0, 8);

  const ids = (botUserId: string) =>
    new Map<string, string>([
      ['everyone', guildId],
      ['member:genie', botUserId],
      ['member:subject', env('SUBJECT_USER_ID')!],
      ['member:other', env('OTHER_USER_ID')!],
      ['member:unknown', env('SUBJECT_USER_ID')!],
      ['role:organizer', env('ORGANIZER_ROLE_ID')!],
      ['role:high', env('HIGH_ROLE_ID')!],
      ['role:sendrole', env('SENDROLE_ID')!],
      ['role:admin', env('ADMIN_ROLE_ID')!],
    ]);

  const caseBase = (c: PermissionCase) => (c.id.includes('-nosend-') ? 'nosend' : 'default');

  describePermissionContract(
    {
      name: 'discord.js adapter (test guild)',
      async world(guild: CaseGuild, c: PermissionCase) {
        const info = await bot.getGuild(guildId);
        if (!info) throw new Error('The contract bot is not in GENIE_CONTRACT_GUILD_ID.');
        const everyone = info.roles.find((r) => r.id === guildId)!.permissions;
        const liveBase = everyone & PERMISSION_BITS.SendMessages ? 'default' : 'nosend';
        if (caseBase(c) !== liveBase) return { skip: `the guild's @everyone base is ${liveBase}; this is a ${caseBase(c)} case` };
        const botRole = info.roles.filter((r) => info.botRoleIds.includes(r.id)).reduce((bits, r) => bits | r.permissions, 0n);
        if (botRole !== guild.genieRole) throw new Error(`The bot's role must hold exactly spike S3's 13 permissions, without Pin Messages (it holds ${botRole}, the case wants ${guild.genieRole}).`);
        if (admin) {
          const adminGuild = await admin.getGuild(guildId);
          if (!adminGuild) throw new Error('GENIE_CONTRACT_ADMIN_TOKEN is not a bot in GENIE_CONTRACT_GUILD_ID.');
        }

        const map = ids(info.botUserId);
        const created: string[] = [];
        // Every channel the run creates is recorded, so cleanup deletes exactly those.
        const tracked = new Proxy(bot, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver) as unknown;
            if (prop !== 'createCategory' && prop !== 'createChannel') return value;
            return async (...args: unknown[]) => {
              const id = (await (value as (...a: unknown[]) => Promise<string>).apply(target, args)) as string;
              created.push(id);
              return id;
            };
          },
        });
        let parent: string | null = null;
        const threads = new Map<string, NonNullable<EffectiveCase['thread']>>();
        return {
          gateway: tracked,
          guildId,
          id: (key: string) => {
            const found = map.get(key);
            if (!found) throw new Error(`No ID for ${key}`);
            return found;
          },
          async parent() {
            parent ??= await tracked.createCategory(guildId, { name: `genie-contract-${runId}`, overwrites: [] });
            return parent;
          },
          async placeAsAdmin(channelId, overwrites) {
            const before = (await bot.getChannel(channelId))?.overwrites ?? [];
            if (!writeRefusal(info.botPermissions, info.botUserId, overwrites, before)) return bot.setOverwrites(channelId, overwrites);
            if (!admin) throw new SkipCase('its setup needs an administrator: set GENIE_CONTRACT_ADMIN_TOKEN');
            const state = await admin.getChannel(channelId);
            if (state?.parentId !== parent && !created.includes(channelId)) throw new Error('The admin client writes only inside the run category.');
            return admin.setOverwrites(channelId, overwrites);
          },
          async addThread(channelId, thread) {
            // The adapter has no thread calls: the resolver reads the channel and applies the case's thread.
            const token = `${channelId}:thread:${threads.size}`;
            threads.set(token, { type: thread.type, archived: thread.archived, subjectIsMember: thread.memberKeys.length > 0 });
            return token;
          },
          async effective(memberKey, channelId, threadId) {
            const state = await bot.getChannel(channelId);
            if (!state) throw new Error(`Channel ${channelId} vanished.`);
            const effectiveCase = c as EffectiveCase;
            const member = memberKey === effectiveCase.subject.key ? effectiveCase.subject : effectiveCase.other;
            const thread = threadId ? threads.get(threadId) : undefined;
            const bits = effectivePermissions({
              guildId,
              guildOwnerId: null,
              roles: [{ id: guildId, permissions: guild.everyone }, ...guild.roles.map((r) => ({ id: map.get(r.key)!, permissions: r.permissions }))],
              member: { userId: map.get(member.key)!, roleIds: member.roles.map((r) => map.get(r)!) },
              channel: { overwrites: state.overwrites },
              ...(thread ? { thread: { type: thread.type, archived: thread.archived, memberIds: thread.subjectIsMember ? [map.get(member.key)!] : [] } } : {}),
            });
            return bits;
          },
          async cleanup() {
            for (const id of created.reverse()) await bot.deleteChannel(id, 'contract run cleanup').catch(() => undefined);
          },
        };
      },
    },
    loadCases(),
  );
}
