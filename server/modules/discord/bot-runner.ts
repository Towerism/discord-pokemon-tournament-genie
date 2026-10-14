import type { Logger } from '@towerism/selfhost-kit';
import { missingPermissions } from '../../../shared/discord/permissions';
import {
  type CommandDefinition,
  type CreateDiscord,
  type Discord,
  type InteractionHandlers,
  DisallowedIntentsError,
  DiscordAuthError,
} from './port';

export type BotError = 'invalid_token' | 'disallowed_intents' | 'discord_unavailable' | 'secrets_unreadable';

export interface BotStatus {
  state: 'stopped' | 'connecting' | 'connected' | 'error';
  error?: BotError;
  latencyMs?: number;
  missingPermissions: string[];
  extraGuilds: { id: string; name: string }[];
}

/** One-shot timers, injected so tests fire them by hand. */
export interface BotScheduler {
  after(ms: number, fn: () => Promise<void>): () => void;
}

export const systemBotScheduler: BotScheduler = {
  after(ms, fn) {
    const handle = setTimeout(() => void fn(), ms);
    handle.unref();
    return () => clearTimeout(handle);
  },
};

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 300_000;

/**
 * Keeps the bot logged in to the gateway (architecture §10). A failure never takes the website down: it is
 * recorded in the status. Discord being unavailable is retried with capped exponential backoff; a refused
 * token, disallowed intents or an unreadable stored token need the organizer, so they aren't retried.
 */
export function createBotRunner(opts: {
  createDiscord: CreateDiscord;
  /** The unsealed bot token. Throws when the vault can't open it. */
  loadToken: () => string;
  guildId: () => string | null;
  commands: readonly CommandDefinition[];
  onInteraction: InteractionHandlers['onInteraction'];
  scheduler: BotScheduler;
  logger: Logger;
}) {
  const { createDiscord, loadToken, guildId, commands, onInteraction, scheduler, logger } = opts;
  let state: BotStatus['state'] = 'stopped';
  let error: BotError | undefined;
  let discord: Discord | null = null;
  let failures = 0;
  let cancelRetry: (() => void) | null = null;
  let generation = 0;

  async function attempt(gen: number): Promise<void> {
    cancelRetry = null;
    state = 'connecting';
    error = undefined;
    let token: string;
    try {
      token = loadToken();
    } catch {
      fail('secrets_unreadable', 'The stored bot token could not be unsealed; check NUXT_VAULT_KEY.');
      return;
    }
    const next = createDiscord(token);
    try {
      await next.bot.connect({ onInteraction });
      if (gen !== generation) {
        await next.bot.disconnect();
        return;
      }
      discord = next;
      const guild = guildId();
      if (guild) await next.bot.setGuildCommands(guild, commands);
      state = 'connected';
      failures = 0;
      logger.info('The bot is connected.', { guildId: guild });
    } catch (err) {
      if (gen !== generation) return;
      await next.bot.disconnect().catch(() => undefined);
      if (err instanceof DiscordAuthError) fail('invalid_token', 'Discord refused the bot token. Paste a new one in Settings.');
      else if (err instanceof DisallowedIntentsError)
        fail('disallowed_intents', 'Turn on the Server Members and Message Content intents in the Discord developer portal.');
      else {
        failures += 1;
        const delay = Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS);
        fail('discord_unavailable', `The bot could not reach Discord; retrying in ${Math.round(delay / 1000)} s.`, err);
        cancelRetry = scheduler.after(delay, () => attempt(gen));
      }
    }
  }

  function fail(code: BotError, message: string, err?: unknown) {
    state = 'error';
    error = code;
    logger.warn(message, { error: code, ...(err === undefined ? {} : { err }) });
  }

  /** Cancels any retry and drops the session synchronously; resolves once it has disconnected. */
  function halt(): Promise<void> {
    generation += 1;
    cancelRetry?.();
    cancelRetry = null;
    const current = discord;
    discord = null;
    state = 'stopped';
    error = undefined;
    return current ? current.bot.disconnect() : Promise.resolve();
  }

  return {
    /** Starts (or restarts) the bot; resolves once the first attempt has settled. */
    async start(): Promise<void> {
      const previous = halt();
      state = 'connecting';
      failures = 0;
      const gen = generation;
      await previous;
      await attempt(gen);
    },
    async stop(): Promise<void> {
      await halt();
    },
    async status(): Promise<BotStatus> {
      const base: BotStatus = { state, missingPermissions: [], extraGuilds: [] };
      if (error) base.error = error;
      if (state !== 'connected' || !discord) return base;
      const latency = discord.bot.latencyMs();
      if (latency !== null) base.latencyMs = latency;
      const bound = guildId();
      try {
        const [guild, guilds] = await Promise.all([bound ? discord.gateway.getGuild(bound) : null, discord.gateway.listGuilds()]);
        if (guild) base.missingPermissions = missingPermissions(guild.botPermissions);
        base.extraGuilds = guilds.filter((g) => g.id !== bound);
      } catch (err) {
        logger.warn('Could not read the bot’s guild state.', { err });
      }
      return base;
    },
  };
}

export type BotRunner = ReturnType<typeof createBotRunner>;
