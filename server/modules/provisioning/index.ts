/**
 * Provisioning (§6.3, ADR-0005): the `provision` and `sync` jobs that make Discord match the day plan, the privacy
 * audit after every apply, the preview, and the open/sync entry points. Plain TS; Discord only through the port.
 */
import { createHash } from 'node:crypto';
import type { Clock, Logger } from '@towerism/selfhost-kit';
import { type AccessPlan, type Principal, accessPlan, canSee, isOrganizer } from '../../../shared/access/access';
import { type BlueprintInput, type DesiredContext, type DesiredDay, type PlanProblem, baseOverwrites, desiredChannels } from '../../../shared/blueprints';
import { type Overwrite, canonical, overwritesEqual } from '../../../shared/discord/overwrites';
import { PERMISSION_BITS, type PermissionName, missingPermissions } from '../../../shared/discord/permissions';
import type { Db } from '../../db/client';
import { type ChannelState, type DiscordGateway, DiscordPermissionError, DiscordUnavailableError, type GuildInfo } from '../discord/port';
import { ServiceError, notFound } from '../errors';
import type { EventDaysService } from '../event-days';
import type { JobContext, Jobs } from '../jobs/jobs';
import { privacyAudit } from './audit';
import { createProvisioningStore } from './store';

export const GUILD_CHANNEL_LIMIT = 500;
export const CATEGORY_CHANNEL_LIMIT = 50;
/** What writing Genie's overwrites needs: a bot can only allow what it holds (ADR-0012). */
const WRITE_PERMISSIONS: PermissionName[] = ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'ManageChannels', 'ManageRoles'];

export interface Binding {
  guildId: string;
  organizerRoleId: string | null;
  headJudgeRoleId: string | null;
}

export type OpenProblem =
  | PlanProblem
  | { code: 'missing_permissions'; permissions: string[] }
  | { code: 'channel_limit'; needed: number; available: number }
  | { code: 'category_limit'; needed: number; max: number };

export interface Preview {
  category: { name: string };
  channels: { key: string; eventId: number | null; name: string; topic: string | null; audience: { staffMemberId: number; displayName: string }[] }[];
  alsoVisibleTo: ['organizer_role', 'bot'];
  problems: PlanProblem[];
  headJudgeRole: 'checked' | 'unavailable';
}

export const overwritesHash = (o: readonly Overwrite[]): string => createHash('sha256').update(canonical(o).join('\n')).digest('hex');

const unavailable = () => new ServiceError(503, 'discord_unavailable', 'Discord could not be reached. Try again in a moment.');

/** The port with each failure naming the call that failed, so a job's error says what Discord refused. */
function naming(discord: DiscordGateway): DiscordGateway {
  return new Proxy(discord, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        try {
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } catch (err) {
          const what = err instanceof DiscordPermissionError ? 'refused' : 'failed';
          throw new Error(`${String(prop)} ${what}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
      };
    },
  });
}

export function createProvisioningService(opts: {
  db: Db;
  clock: Clock;
  logger: Logger;
  eventDays: EventDaysService;
  jobs: Jobs;
  /** The port for the stored bot token. */
  gateway: () => DiscordGateway;
  binding: () => Binding | null;
}) {
  const { db, clock, logger, eventDays, jobs, gateway, binding } = opts;
  const store = createProvisioningStore(db);

  function requireBinding(): Binding & { organizerRoleId: string } {
    const b = binding();
    if (!b) throw new ServiceError(409, 'setup_incomplete', 'Finish setup first.');
    if (!b.organizerRoleId) throw new Error('roles_unmapped');
    return b as Binding & { organizerRoleId: string };
  }

  /** The desired day with what only Discord knows: the bot, the head-judge role holders and who is still in the guild. */
  function desiredWith(dayId: number, b: Binding & { organizerRoleId: string }, guild: GuildInfo, members: { userId: string; roleIds: string[] }[]): { desired: DesiredDay; blueprint: BlueprintInput } {
    const blueprint = eventDays.blueprint(eventDays.plan(dayId).day.blueprintId);
    const ctx: DesiredContext = {
      guildId: b.guildId,
      botUserId: guild.botUserId,
      organizerRoleId: b.organizerRoleId,
      headJudgeRoleHolders: new Set(b.headJudgeRoleId ? members.filter((m) => m.roleIds.includes(b.headJudgeRoleId!)).map((m) => m.userId) : []),
      guildMemberIds: new Set(members.map((m) => m.userId)),
    };
    return { desired: desiredChannels(eventDays.planInput(dayId), blueprint, ctx), blueprint };
  }

  // ---- the job

  async function apply(ctx: JobContext): Promise<void> {
    const dayId = ctx.dayId!;
    const b = requireBinding();
    const discord = naming(gateway());
    const guild = await discord.getGuild(b.guildId);
    if (!guild) throw new Error('bot_not_in_guild');

    // 1. Permissions: what writing overwrites needs fails the job; the rest only warns, so a removal still lands.
    const held = guild.botPermissions & PERMISSION_BITS.Administrator ? -1n : guild.botPermissions;
    const missingWrite = WRITE_PERMISSIONS.filter((p) => (held & PERMISSION_BITS[p]) === 0n);
    if (missingWrite.length) throw new Error(`missing_permissions: ${missingWrite.join(', ')}`);
    const missingOther = missingPermissions(guild.botPermissions).filter((p) => !WRITE_PERMISSIONS.includes(p));
    if (missingOther.length) ctx.log('warn', `The bot lacks ${missingOther.join(', ')}; the day is synced, but fix the bot's role.`, { missing: missingOther });

    const members = await discord.listMembers(b.guildId);
    // The plan and its revision, read together: nothing awaits between them.
    const revision = eventDays.plan(dayId).sync.planRevision;
    const { desired, blueprint } = desiredWith(dayId, b, guild, members);
    const base = baseOverwrites({ guildId: b.guildId, botUserId: guild.botUserId, organizerRoleId: b.organizerRoleId });
    const now = () => clock.now();

    // 2. The category.
    let categoryId = eventDays.plan(dayId).day.categoryId;
    const category = categoryId ? await discord.getChannel(categoryId) : null;
    if (!category) {
      if (categoryId) ctx.log('warn', 'The day’s category is gone from Discord: creating a new one.', { categoryId });
      const recorded = eventDays.recordedCategoryIds();
      const strays = (await discord.listChannels(b.guildId)).filter((c) => c.type === 'category' && c.name === desired.category.name && !recorded.has(c.id));
      if (strays.length) {
        store.addOrphans(dayId, b.guildId, 'category', strays, now());
        for (const s of strays) ctx.log('warn', `Found a category Genie didn't record: ${s.name}`, { channelId: s.id });
      }
      categoryId = await discord.createCategory(b.guildId, { name: desired.category.name, overwrites: desired.category.overwrites });
      eventDays.recordCategory(dayId, categoryId);
      ctx.log('info', `Created the category ${desired.category.name}.`, { channelId: categoryId });
    } else {
      if (category.name !== desired.category.name) await discord.updateChannel(categoryId!, { name: desired.category.name });
      if (!overwritesEqual(category.overwrites, desired.category.overwrites)) await discord.setOverwrites(categoryId!, desired.category.overwrites);
    }
    const parentId = categoryId!;

    // 3. Existing channels first, so removals land before any create can fail.
    const rows = store.present(dayId);
    const rowFor = (key: string, eventId: number | null) => rows.find((r) => r.blueprintChannelKey === key && r.eventId === eventId);
    const toCreate: typeof desired.channels = [];
    for (const want of desired.channels) {
      const row = rowFor(want.key, want.eventId);
      let state = row ? await discord.getChannel(row.discordChannelId) : null;
      if (row && !state) {
        store.update(row.id, { state: 'missing' }, now());
        ctx.log('warn', `#${want.name} is gone from Discord: creating a new one.`, { channelId: row.discordChannelId });
      }
      if (!row || !state) {
        toCreate.push(want);
        continue;
      }
      const patch: { name?: string; topic?: string | null; parentId?: string } = {};
      if (state.name !== want.name) patch.name = want.name;
      if ((state.topic ?? null) !== want.topic) patch.topic = want.topic;
      if (state.parentId !== parentId) patch.parentId = parentId;
      if (Object.keys(patch).length) {
        await discord.updateChannel(state.id, patch);
        // Defensive: a move never syncs overwrites (the port's contract), but compare what Discord now holds.
        if (patch.parentId) state = (await discord.getChannel(state.id)) ?? state;
      }
      if (!overwritesEqual(state.overwrites, want.overwrites)) {
        await discord.setOverwrites(state.id, want.overwrites);
        ctx.log('info', `Updated who can see #${want.name}.`, { channelId: state.id, audience: want.audience.length });
      }
      if (row.appliedOverwritesHash !== overwritesHash(want.overwrites)) store.update(row.id, { appliedOverwritesHash: overwritesHash(want.overwrites) }, now());
    }
    for (const row of rows) {
      if (desired.channels.some((d) => d.key === row.blueprintChannelKey && d.eventId === row.eventId)) continue;
      const state = await discord.getChannel(row.discordChannelId);
      if (state && !overwritesEqual(state.overwrites, base)) await discord.setOverwrites(row.discordChannelId, base);
      ctx.log('warn', 'A recorded channel no longer matches the plan: its members were removed; it is kept.', { channelId: row.discordChannelId });
    }

    // 4. Then creates: with the base overwrites, recorded before the next call, then given their audience.
    if (toCreate.length) {
      const all = await discord.listChannels(b.guildId);
      const inCategory = all.filter((c) => c.parentId === parentId).length;
      if (all.length + toCreate.length > GUILD_CHANNEL_LIMIT) throw new Error(`channel_limit: ${toCreate.length} needed, ${GUILD_CHANNEL_LIMIT - all.length} free`);
      if (inCategory + toCreate.length > CATEGORY_CHANNEL_LIMIT) throw new Error(`category_limit: ${inCategory + toCreate.length} in the category`);
    }
    for (const want of toCreate) {
      const channelId = await discord.createChannel(b.guildId, { name: want.name, parentId, topic: want.topic, overwrites: base });
      store.record({ dayId, guildId: b.guildId, eventId: want.eventId, key: want.key, channelId, hash: overwritesHash(base), now: now() });
      ctx.log('info', `Created #${want.name}.`, { channelId });
      await discord.setOverwrites(channelId, want.overwrites);
      const row = rowFor(want.key, want.eventId) ?? store.present(dayId).find((r) => r.discordChannelId === channelId)!;
      store.update(row.id, { appliedOverwritesHash: overwritesHash(want.overwrites) }, now());
    }

    // 5. Orphans: channels in the category Genie didn't record.
    const recordedIds = new Set(store.present(dayId).map((r) => r.discordChannelId));
    const under = (await discord.listChannels(b.guildId)).filter((c) => c.parentId === parentId);
    const orphans = under.filter((c) => !recordedIds.has(c.id));
    store.replaceOrphans(dayId, b.guildId, 'channel', orphans, now());
    for (const o of orphans) ctx.log('warn', `Found #${o.name} in the day's category; Genie didn't create it.`, { channelId: o.id });

    // 6. The privacy audit, on what Discord holds now.
    const present = store.present(dayId);
    const states: { key: string; eventId: number | null; state: ChannelState; audienceUserIds: string[] }[] = [];
    for (const want of desired.channels) {
      const row = present.find((r) => r.blueprintChannelKey === want.key && r.eventId === want.eventId)!;
      const state = await discord.getChannel(row.discordChannelId);
      if (!state) throw new Error(`#${want.name} vanished during the sync`);
      states.push({ key: want.key, eventId: want.eventId, state, audienceUserIds: want.audience.map((a) => a.discordUserId) });
    }
    const categoryState = await discord.getChannel(parentId);
    if (!categoryState) throw new Error('The category vanished during the sync');
    const audit = privacyAudit({
      guild: { guildId: b.guildId, ownerId: guild.ownerId, roles: guild.roles, members },
      botUserId: guild.botUserId,
      organizerRoleId: b.organizerRoleId,
      category: categoryState,
      channels: states,
      orphans,
    });
    for (const o of audit.orphanViewers) ctx.log('warn', `Staff outside Genie's plan can see #${o.name}.`, { channelId: o.channelId, users: o.users });
    if (audit.failures.length) {
      ctx.log('error', 'privacy audit failed: these channels are visible to the wrong people', { failures: audit.failures });
      throw new Error('privacy_audit_failed');
    }
    ctx.log('info', `also visible to: ${audit.alsoVisible.administrators} administrators, ${audit.alsoVisible.organizers} organizers`);

    // 7. The intro and the panel, posted once, the intro pinned.
    await postOnce(ctx, blueprint, desired, dayId, 'all_staff', {
      content: 'This category is for today’s staff only. Penalties go in each event’s penalty channel. It will be locked and deleted after the day is closed.',
      pin: true,
    });
    await postOnce(ctx, blueprint, desired, dayId, 'head_judges', {
      content: 'Head judges and organizers: Sync applies the day plan to these channels.',
      buttons: [{ customId: `genie:day-sync:${dayId}`, label: 'Sync' }],
      pin: false,
    });

    // 8. Applied.
    eventDays.recordApplied(dayId, revision);
    ctx.log('info', `Synced ${desired.channels.length} channels.`, { revision });
  }

  async function postOnce(
    ctx: JobContext,
    blueprint: BlueprintInput,
    desired: DesiredDay,
    dayId: number,
    audience: 'all_staff' | 'head_judges',
    msg: { content: string; buttons?: { customId: string; label: string }[]; pin: boolean },
  ): Promise<void> {
    const key = blueprint.channels.filter((c) => c.scope === 'day' && c.audience === audience).sort((a, b) => a.position - b.position)[0]?.key;
    if (!key || !desired.channels.some((c) => c.key === key && c.eventId === null)) {
      ctx.log('info', `The blueprint has no day channel for ${audience === 'all_staff' ? 'all staff' : 'head judges'}: no ${msg.pin ? 'intro' : 'panel'} posted.`);
      return;
    }
    const discord = naming(gateway());
    const row = store.present(dayId).find((r) => r.blueprintChannelKey === key && r.eventId === null)!;
    let messageId = row.messageId;
    if (!messageId) {
      messageId = await discord.postMessage(row.discordChannelId, { content: msg.content, ...(msg.buttons ? { buttons: msg.buttons } : {}) });
      store.update(row.id, { messageId }, clock.now());
    }
    if (msg.pin && !row.messagePinned) {
      await discord.pinMessage(row.discordChannelId, messageId);
      store.update(row.id, { messagePinned: true }, clock.now());
    }
  }

  // ---- entry points

  async function liveGuild(b: Binding): Promise<{ guild: GuildInfo; members: { userId: string; roleIds: string[] }[]; channelCount: number }> {
    try {
      const discord = gateway();
      const guild = await discord.getGuild(b.guildId);
      if (!guild) throw unavailable();
      const members = await discord.listMembers(b.guildId);
      return { guild, members, channelCount: guild.channelCount };
    } catch (err) {
      if (err instanceof DiscordUnavailableError || err instanceof ServiceError) throw unavailable();
      throw err;
    }
  }

  return {
    register(): void {
      jobs.register('provision', apply, { retryOnBoot: true });
      jobs.register('sync', apply, { retryOnBoot: true });
    },

    /** checks the preconditions, then opens the day and queues its provision job. */
    async open(dayId: number): Promise<{ jobId: number }> {
      const plan = eventDays.plan(dayId);
      if (plan.day.state !== 'draft') throw new ServiceError(409, 'day_not_draft', 'This day has already been opened.');
      const b = requireBinding();
      const { guild, members, channelCount } = await liveGuild(b);
      const { desired } = desiredWith(dayId, b, guild, members);
      const problems: OpenProblem[] = [...desired.problems];
      const missing = missingPermissions(guild.botPermissions);
      if (missing.length) problems.push({ code: 'missing_permissions', permissions: missing });
      const needed = desired.channels.length + 1;
      if (channelCount + needed > GUILD_CHANNEL_LIMIT) problems.push({ code: 'channel_limit', needed, available: GUILD_CHANNEL_LIMIT - channelCount });
      if (desired.channels.length > CATEGORY_CHANNEL_LIMIT) problems.push({ code: 'category_limit', needed: desired.channels.length, max: CATEGORY_CHANNEL_LIMIT });
      if (problems.length) throw new ServiceError(422, 'open_preconditions_failed', 'The day can’t be opened yet.', { problems });
      const jobId = eventDays.openDay(dayId, () => jobs.enqueue({ kind: 'provision', dayId }));
      logger.info('Day opened.', { dayId, jobId });
      return { jobId };
    },

    /** a sync, coalesced with one already queued. */
    sync(dayId: number): { jobId: number; coalesced: boolean } {
      if (eventDays.plan(dayId).day.state !== 'open') throw new ServiceError(409, 'day_not_open', 'Only an open day can be synced.');
      return jobs.enqueueUnlessQueued({ kind: 'sync', dayId });
    },

    /** the desired channels and audiences; a non-organizer sees only the channels `canSee` allows. */
    async preview(dayId: number, principal: Principal | null): Promise<Preview> {
      const plan = eventDays.plan(dayId);
      const blueprint = eventDays.blueprint(plan.day.blueprintId);
      const b = requireBinding();
      let headJudgeRole: Preview['headJudgeRole'] = 'checked';
      let ctx: DesiredContext = { guildId: b.guildId, botUserId: '0', organizerRoleId: b.organizerRoleId, headJudgeRoleHolders: new Set(), guildMemberIds: null };
      try {
        const { guild, members } = await liveGuild(b);
        ctx = {
          ...ctx,
          botUserId: guild.botUserId,
          headJudgeRoleHolders: new Set(b.headJudgeRoleId ? members.filter((m) => m.roleIds.includes(b.headJudgeRoleId!)).map((m) => m.userId) : []),
        };
      } catch (err) {
        if (!(err instanceof ServiceError)) throw err;
        headJudgeRole = 'unavailable';
      }
      const input = eventDays.planInput(dayId);
      const desired = desiredChannels(input, blueprint, ctx);
      const access = accessPlan(input, desired);
      const visible = (key: string, eventId: number | null) => !principal || isOrganizer(principal.grant) || canSee(principal, { kind: 'channel', blueprintKey: key, eventId }, access);
      const names = new Map(plan.staff.map((s) => [s.staffMemberId, s.displayName]));
      return {
        category: { name: desired.category.name },
        channels: desired.channels
          .filter((c) => visible(c.key, c.eventId))
          .map((c) => ({ key: c.key, eventId: c.eventId, name: c.name, topic: c.topic, audience: c.audience.map((a) => ({ staffMemberId: a.staffMemberId, displayName: names.get(a.staffMemberId)! })) })),
        alsoVisibleTo: ['organizer_role', 'bot'],
        problems: desired.problems.filter(
          (p) => p.code !== 'duplicate_channel_name' || !principal || isOrganizer(principal.grant) || desired.channels.filter((c) => c.name === p.name).every((c) => visible(c.key, c.eventId)),
        ),
        headJudgeRole,
      };
    },

    /** The access plan for `canSee` on this day, without Discord: the principal's own head-judge role is all that's needed. */
    accessPlan(dayId: number, principal: Principal): AccessPlan {
      const plan = eventDays.plan(dayId);
      const input = eventDays.planInput(dayId);
      const holders = new Set(principal.holdsHeadJudgeRole ? [principal.userId] : []);
      const desired = desiredChannels(input, eventDays.blueprint(plan.day.blueprintId), {
        guildId: '0',
        botUserId: '0',
        organizerRoleId: '0',
        headJudgeRoleHolders: holders,
        guildMemberIds: null,
      });
      return accessPlan(input, desired);
    },

    channels(dayId: number) {
      return store.channels(dayId).map((r) => ({ key: r.blueprintChannelKey, eventId: r.eventId, discordChannelId: r.discordChannelId, state: r.state }));
    },
    orphans(dayId: number) {
      return store.orphans(dayId).map((o) => ({ discordChannelId: o.discordChannelId, kind: o.kind, name: o.name, foundAt: o.foundAt }));
    },

    /** records an orphan channel as the day's channel for a desired key that has none. */
    adoptOrphan(dayId: number, channelId: string, target: { key: string; eventId: number | null }): void {
      store.transaction(() => {
        const orphan = store.orphan(dayId, channelId);
        if (!orphan || orphan.kind !== 'channel') throw notFound('orphan');
        const plan = eventDays.plan(dayId);
        const blueprint = eventDays.blueprint(plan.day.blueprintId);
        const channel = blueprint.channels.find((c) => c.key === target.key);
        const eventOk = channel && (channel.scope === 'day' ? target.eventId === null : plan.events.some((e) => e.id === target.eventId));
        if (!eventOk) throw new ServiceError(422, 'unknown_key', 'No such channel in the day’s blueprint.');
        if (store.present(dayId).some((r) => r.blueprintChannelKey === target.key && r.eventId === target.eventId)) {
          throw new ServiceError(409, 'already_provisioned', 'The day already has that channel.');
        }
        store.record({ dayId, guildId: orphan.guildId, eventId: target.eventId, key: target.key, channelId, hash: '', now: clock.now() });
        store.dropOrphan(channelId);
        eventDays.touch(dayId);
      });
    },

    /** deletes an orphan, but only while it is still in the day's category. */
    async deleteOrphan(dayId: number, channelId: string): Promise<void> {
      const orphan = store.orphan(dayId, channelId);
      if (!orphan) throw notFound('orphan');
      const discord = gateway();
      let state: ChannelState | null;
      try {
        state = await discord.getChannel(channelId);
      } catch (err) {
        if (err instanceof DiscordUnavailableError) throw unavailable();
        throw err;
      }
      const categoryId = eventDays.plan(dayId).day.categoryId;
      if (state) {
        const children = orphan.kind === 'category' ? (await discord.listChannels(orphan.guildId)).filter((c) => c.parentId === channelId) : [];
        const stillOurs = orphan.kind === 'channel' ? state.parentId === categoryId : children.length === 0;
        if (!stillOurs) {
          store.dropOrphan(channelId);
          throw new ServiceError(409, 'orphan_moved', 'That channel has moved or filled up since it was found; Genie left it alone.');
        }
        await discord.deleteChannel(channelId, 'delete a channel found in a day category');
      }
      store.dropOrphan(channelId);
      eventDays.touch(dayId);
      logger.info('Orphan deleted.', { dayId, channelId });
    },

    alarms: () => eventDays.alarms(),

    /** after `jobs.recover()`, a sync for every open day whose removals may not have landed. */
    recoverOnBoot(): void {
      for (const dayId of eventDays.daysNeedingRevocation()) {
        const { jobId, coalesced } = jobs.enqueueUnlessQueued({ kind: 'sync', dayId });
        logger.info('Boot: sync queued for pending removals.', { dayId, jobId, coalesced });
      }
    },
  };
}

export type ProvisioningService = ReturnType<typeof createProvisioningService>;
