import { describe, expect, it } from 'vitest';
import { INVITE_PERMISSIONS, PERMISSION_BITS } from '../../../shared/discord/permissions';
import { recordingLogger } from '../../../test/support/logger';
import { type BotScheduler, createBotRunner } from './bot-runner';
import { createFakeDiscord } from './fake';

const APP = '300000000000000001';
const TOKEN = 'fake-bot-token-runner';
const GUILD = '400000000000000001';
const ALL = INVITE_PERMISSIONS.reduce((sum, name) => sum | PERMISSION_BITS[name], 0n);

function setup() {
  const discord = createFakeDiscord();
  discord.addApplication({ id: APP, token: TOKEN });
  discord.addGuild({ id: GUILD, name: 'Store' });
  discord.inviteBot(APP, GUILD, { permissions: ALL });
  const scheduler = fakeScheduler();
  const logger = recordingLogger();
  let token: () => string = () => TOKEN;
  const runner = createBotRunner({
    createDiscord: discord.create,
    loadToken: () => token(),
    guildId: () => GUILD,
    commands: [],
    onInteraction: async (_i, reply) => reply.ephemeral('handled'),
    scheduler,
    logger,
  });
  return { discord, scheduler, logger, runner, setToken: (fn: () => string) => (token = fn) };
}

describe('the bot runner', () => {
  it('connects, clears the bound guild’s commands, and reports a healthy status', async () => {
    const { discord, runner } = setup();
    discord.commands.set(GUILD, [{ name: 'stale', description: 'left over' }]);
    expect((await runner.status()).state).toBe('stopped');

    const starting = runner.start();
    expect((await runner.status()).state).toBe('connecting');
    await starting;

    expect(await runner.status()).toEqual({ state: 'connected', latencyMs: 42, missingPermissions: [], extraGuilds: [] });
    expect(discord.commands.get(GUILD)).toEqual([]);
    expect(
      await discord.dispatch({ id: '1', kind: 'command', name: 'x', guildId: GUILD, channelId: null, userId: '2', options: {}, memberRoleIds: [], userDisplayName: 'x' }),
    ).toEqual([
      'handled',
    ]);
  });

  it('reports missing permissions and other guilds from the live guild state', async () => {
    const { discord, runner } = setup();
    await runner.start();
    const role = discord.guilds.get(GUILD)!.roles.find((r) => r.managed)!;
    role.permissions = ALL & ~PERMISSION_BITS.ManageThreads;
    discord.addGuild({ id: '400000000000000002', name: 'Elsewhere' });
    discord.inviteBot(APP, '400000000000000002');

    const status = await runner.status();
    expect(status.missingPermissions).toEqual(['ManageThreads']);
    expect(status.extraGuilds).toEqual([{ id: '400000000000000002', name: 'Elsewhere' }]);
  });

  it('retries an unavailable gateway with capped exponential backoff, then connects', async () => {
    const { discord, scheduler, runner } = setup();
    discord.connectFailure = 'unavailable';
    await runner.start();
    expect(await runner.status()).toMatchObject({ state: 'error', error: 'discord_unavailable' });

    for (let i = 0; i < 10; i += 1) await scheduler.fire();
    expect(scheduler.delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000]);

    discord.connectFailure = null;
    await scheduler.fire();
    expect((await runner.status()).state).toBe('connected');
    expect(scheduler.pending()).toBe(0);
  });

  it.each([
    ['invalid_token', 'invalid_token'],
    ['disallowed_intents', 'disallowed_intents'],
  ] as const)('stops without retrying when the gateway refuses with %s', async (failure, error) => {
    const { discord, scheduler, runner } = setup();
    discord.connectFailure = failure;
    await runner.start();
    expect(await runner.status()).toMatchObject({ state: 'error', error });
    expect(scheduler.pending()).toBe(0);
    expect(discord.connectAttempts).toBe(1);
  });

  it('stops without retrying when the stored token cannot be unsealed, and never logs it', async () => {
    const { discord, scheduler, runner, logger, setToken } = setup();
    setToken(() => {
      throw new Error('The vault vault key could not open the blob.');
    });
    await runner.start();
    expect(await runner.status()).toMatchObject({ state: 'error', error: 'secrets_unreadable' });
    expect(scheduler.pending()).toBe(0);
    expect(discord.connectAttempts).toBe(0);
    expect(JSON.stringify(logger.records)).not.toContain(TOKEN);
  });

  it('notices a session Discord ends after connecting, and retries only when Discord was unavailable', async () => {
    const { discord, scheduler, runner } = setup();
    await runner.start();
    discord.dropConnection('disallowed_intents');
    expect(await runner.status()).toMatchObject({ state: 'error', error: 'disallowed_intents' });
    expect(scheduler.pending()).toBe(0);

    await runner.start();
    discord.dropConnection('unavailable');
    expect(await runner.status()).toMatchObject({ state: 'error', error: 'discord_unavailable' });
    expect(scheduler.delays).toEqual([1_000]);
    await scheduler.fire();
    expect((await runner.status()).state).toBe('connected');
  });

  it('disconnects on stop and cancels a pending retry', async () => {
    const { discord, scheduler, runner } = setup();
    await runner.start();
    await runner.stop();
    expect(discord.connected).toBe(false);
    expect((await runner.status()).state).toBe('stopped');

    discord.connectFailure = 'unavailable';
    await runner.start();
    expect(scheduler.pending()).toBe(1);
    await runner.stop();
    expect(scheduler.pending()).toBe(0);
  });
});

function fakeScheduler(): BotScheduler & { delays: number[]; fire(): Promise<void>; pending(): number } {
  const queue: Array<{ fn: () => Promise<void>; cancelled: boolean }> = [];
  const delays: number[] = [];
  return {
    delays,
    after(ms, fn) {
      delays.push(ms);
      const entry = { fn, cancelled: false };
      queue.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    async fire() {
      const entry = queue.shift();
      if (entry && !entry.cancelled) await entry.fn();
    },
    pending: () => queue.filter((e) => !e.cancelled).length,
  };
}

describe('a retry that fires after stop', () => {
  it('leaves the bot stopped', async () => {
    const discord = createFakeDiscord();
    discord.addApplication({ id: APP, token: TOKEN });
    discord.connectFailure = 'unavailable';
    const fired: Array<() => Promise<void>> = [];
    const runner = createBotRunner({
      createDiscord: discord.create,
      loadToken: () => TOKEN,
      guildId: () => GUILD,
      commands: [],
      onInteraction: async () => {},
      // A timer that can't be cancelled: it has already fired when stop runs.
      scheduler: { after: (_ms, fn) => (fired.push(fn), () => {}) },
      logger: recordingLogger(),
    });
    await runner.start();
    await runner.stop();
    await fired[0]!();
    expect((await runner.status()).state).toBe('stopped');
    expect(discord.connectAttempts).toBe(1);
  });
});
