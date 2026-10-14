/**
 * The `DiscordGateway` port over discord.js (ADR-0003). The only file that imports discord.js; its payload
 * shapes stop here. Covered by the built-app tests against an HTTP fake of Discord, and by the manual smoke on
 * the test guild (Discord has no sandbox).
 */
import type { Logger } from '@towerism/selfhost-kit';
import {
  type APIApplication,
  type APIGuild,
  type APIGuildMember,
  type APIUser,
  type Interaction,
  Client,
  DiscordAPIError,
  DiscordjsError,
  DiscordjsErrorCodes,
  Events,
  GatewayCloseCodes,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
} from 'discord.js';
import type { Member } from '../../../../../shared/access/access';
import {
  type CreateDiscord,
  type DiscordBotConnection,
  type DiscordGateway,
  type GuildInfo,
  type InboundInteraction,
  DisallowedIntentsError,
  DiscordAuthError,
  DiscordUnavailableError,
} from '../../port';

const READY_TIMEOUT_MS = 30_000;
/** Discord JSON error codes that mean "not there" or "can't see it". */
const UNKNOWN_GUILD = 10004;
const UNKNOWN_MEMBER = 10007;
const MISSING_ACCESS = 50001;

/** Distinct tokens kept (the stored one, plus a few the setup wizard tried). */
const MAX_CLIENTS = 4;

export function createDiscordJs(opts: { apiUrl: string; logger: Logger }): CreateDiscord {
  const { apiUrl, logger } = opts;
  // One REST client per token: each holds Discord's rate-limit buckets and two sweeper timers, so building one
  // per call would ignore the buckets across calls and leak the timers.
  const clients = new Map<string, REST>();
  const restFor = (token: string): REST => {
    const cached = clients.get(token);
    if (cached) {
      clients.delete(token);
      clients.set(token, cached);
      return cached;
    }
    const rest = new REST({ version: '10', api: apiUrl, timeout: 15_000, retries: 2 }).setToken(token);
    clients.set(token, rest);
    if (clients.size > MAX_CLIENTS) {
      const [oldest, evicted] = clients.entries().next().value as [string, REST];
      clients.delete(oldest);
      evicted.clearHashSweeper();
      evicted.clearHandlerSweeper();
    }
    return rest;
  };
  return (token) => {
    const rest = restFor(token);
    let botUserId: string | null = null;

    const call = async <T>(fn: () => Promise<unknown>): Promise<T> => {
      try {
        return (await fn()) as T;
      } catch (err) {
        throw translate(err);
      }
    };
    /** A raw REST call whose "not there" answers (`codes`, or a 404) mean `null`; anything else is translated. */
    const orNull = async <T>(fn: () => Promise<unknown>, codes: number[]): Promise<T | null> => {
      try {
        return (await fn()) as T;
      } catch (err) {
        if (err instanceof DiscordAPIError && typeof err.code === 'number' && codes.includes(err.code)) return null;
        if (err instanceof DiscordAPIError && err.status === 404) return null;
        throw translate(err);
      }
    };
    const botId = async () => (botUserId ??= (await call<APIUser>(() => rest.get(Routes.user('@me')))).id);

    const gateway: DiscordGateway = {
      async getApplication() {
        const app = await call<APIApplication>(() => rest.get(Routes.currentApplication()));
        return { id: app.id, botPublic: app.bot_public, flags: app.flags ?? 0 };
      },
      async listGuilds() {
        const guilds = await call<{ id: string; name: string }[]>(() => rest.get(Routes.userGuilds(), { query: new URLSearchParams({ limit: '200' }) }));
        return guilds.map((g) => ({ id: g.id, name: g.name }));
      },
      async getGuild(guildId) {
        const guild = await orNull<APIGuild>(() => rest.get(Routes.guild(guildId)), [UNKNOWN_GUILD, MISSING_ACCESS]);
        if (!guild) return null;
        const bot = await botId();
        const self = await orNull<APIGuildMember>(() => rest.get(Routes.guildMember(guildId, bot)), [UNKNOWN_MEMBER, MISSING_ACCESS]);
        if (!self) return null;
        return guildInfo(guild, self.roles);
      },
      async getMember(guildId, userId): Promise<Member | null> {
        const member = await orNull<APIGuildMember>(() => rest.get(Routes.guildMember(guildId, userId)), [UNKNOWN_MEMBER]);
        return member ? { userId, roleIds: [...member.roles] } : null;
      },
    };

    let client: Client | null = null;
    const bot: DiscordBotConnection = {
      async connect(handlers) {
        const next = new Client({
          intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent],
          rest: { api: apiUrl },
        });
        client = next;
        let connected = false;
        const ready = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new DiscordUnavailableError('The gateway did not become ready in time.')), READY_TIMEOUT_MS);
          next.once(Events.ClientReady, () => {
            clearTimeout(timer);
            connected = true;
            resolve();
          });
          next.on(Events.ShardDisconnect, (event) => {
            clearTimeout(timer);
            const reason =
              event.code === GatewayCloseCodes.DisallowedIntents
                ? 'disallowed_intents'
                : event.code === GatewayCloseCodes.AuthenticationFailed
                  ? 'invalid_token'
                  : 'unavailable';
            if (!connected) {
              reject(reason === 'disallowed_intents' ? new DisallowedIntentsError('Disallowed intents.') : reason === 'invalid_token' ? new DiscordAuthError('Authentication failed.') : new DiscordUnavailableError(`Gateway closed with ${event.code}.`));
            } else {
              handlers.onDisconnected?.(reason);
            }
          });
        });
        next.on(Events.InteractionCreate, (interaction) => {
          void dispatch(interaction, handlers.onInteraction, logger);
        });
        next.on(Events.Error, (err) => logger.warn('Discord client error.', { err }));
        try {
          await next.login(token);
          await ready;
        } catch (err) {
          await next.destroy().catch(() => undefined);
          client = null;
          if (err instanceof DisallowedIntentsError || err instanceof DiscordAuthError || err instanceof DiscordUnavailableError) throw err;
          throw translate(err);
        }
      },
      async disconnect() {
        const current = client;
        client = null;
        await current?.destroy();
      },
      latencyMs() {
        const ping = client?.ws.ping ?? -1;
        return ping >= 0 ? ping : null;
      },
      async setGuildCommands(guildId, commands) {
        const appId = client?.application?.id ?? (await gateway.getApplication()).id;
        await call(() => rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands }));
      },
    };

    return { gateway, bot };
  };
}

function guildInfo(guild: APIGuild, botRoleIds: readonly string[]): GuildInfo {
  const roles = guild.roles.map((r) => ({
    id: r.id,
    name: r.name,
    position: r.position,
    managed: r.managed,
    permissions: BigInt(r.permissions),
  }));
  const everyone = roles.find((r) => r.id === guild.id);
  const mine = roles.filter((r) => botRoleIds.includes(r.id));
  return {
    id: guild.id,
    name: guild.name,
    roles,
    botRoleIds: [...botRoleIds],
    botHighestRolePosition: Math.max(0, ...mine.map((r) => r.position)),
    botPermissions: mine.reduce((bits, r) => bits | r.permissions, everyone?.permissions ?? 0n),
  };
}

async function dispatch(interaction: Interaction, onInteraction: (i: InboundInteraction, reply: { ephemeral(text: string): Promise<void> }) => Promise<void>, logger: Logger) {
  let inbound: InboundInteraction;
  if (interaction.isChatInputCommand()) inbound = base(interaction, 'command', interaction.commandName);
  else if (interaction.isMessageComponent()) inbound = base(interaction, 'component', interaction.customId);
  else if (interaction.isModalSubmit()) inbound = base(interaction, 'modal', interaction.customId);
  else return;
  const reply = {
    async ephemeral(text: string) {
      if (!interaction.isRepliable()) return;
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
    },
  };
  try {
    await onInteraction(inbound, reply);
  } catch (err) {
    logger.error('An interaction handler escaped the router.', { interactionId: interaction.id, err });
  }
}

function base(interaction: Interaction, kind: InboundInteraction['kind'], name: string): InboundInteraction {
  return { id: interaction.id, kind, name, guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id };
}

function translate(err: unknown): Error {
  if (err instanceof DiscordAPIError && err.status === 401) return new DiscordAuthError('Discord refused the bot token.');
  if (err instanceof DiscordjsError && err.code === DiscordjsErrorCodes.TokenInvalid) return new DiscordAuthError('Discord refused the bot token.');
  // Any other refusal (403 Missing Access when the bot lost the guild, say) means Discord can't answer this for us.
  if (err instanceof DiscordAPIError && err.status < 500 && err.status !== 403) return err;
  return new DiscordUnavailableError(`Discord could not be reached: ${err instanceof Error ? err.message : String(err)}`);
}
