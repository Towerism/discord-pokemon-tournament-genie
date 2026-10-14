/**
 * The only way modules reach Discord (ADR-0003). Only `adapters/discordjs/` implements it against Discord;
 * `fake/` implements it in memory for tests. Payload shapes never cross this boundary.
 *
 * M1 has the application, guild and member reads the setup wizard and login need, plus the gateway
 * connection. Later milestones add the channel, message and thread methods of architecture §4.1.
 */
import type { Member } from '../../../shared/access/access';

export type Snowflake = string;

export interface ApplicationInfo {
  id: Snowflake;
  botPublic: boolean;
  /** The application's flags: bits 14/15 are the Server Members intent, 18/19 Message Content. */
  flags: number;
}

export interface GuildRole {
  id: Snowflake;
  name: string;
  position: number;
  managed: boolean;
  permissions: bigint;
}

export interface GuildInfo {
  id: Snowflake;
  name: string;
  roles: GuildRole[];
  botRoleIds: Snowflake[];
  botHighestRolePosition: number;
  /** The bot's guild permissions: `@everyone` combined with its roles. */
  botPermissions: bigint;
}

export type { Member };

export interface DiscordGateway {
  /** @throws DiscordAuthError for a token Discord refuses; DiscordUnavailableError when Discord can't answer. */
  getApplication(): Promise<ApplicationInfo>;
  listGuilds(): Promise<{ id: Snowflake; name: string }[]>;
  /** `null` when the bot isn't in the guild. */
  getGuild(guildId: Snowflake): Promise<GuildInfo | null>;
  /** `null` when the user isn't a member. */
  getMember(guildId: Snowflake, userId: Snowflake): Promise<Member | null>;
}

/** An interaction in Genie's terms; the adapter builds it from discord.js's. */
export interface InboundInteraction {
  id: Snowflake;
  kind: 'command' | 'component' | 'modal';
  name: string;
  guildId: Snowflake | null;
  channelId: Snowflake | null;
  userId: Snowflake;
}

export interface InteractionReply {
  ephemeral(text: string): Promise<void>;
}

export interface CommandDefinition {
  name: string;
  description: string;
}

export type DisconnectReason = 'invalid_token' | 'disallowed_intents' | 'unavailable';

export interface InteractionHandlers {
  onInteraction(interaction: InboundInteraction, reply: InteractionReply): Promise<void>;
  /** The session ended for good after `connect` resolved (Discord won't resume it on its own). */
  onDisconnected?(reason: DisconnectReason): void;
}

/** The bot's gateway session. */
export interface DiscordBotConnection {
  /** Resolves once ready. @throws DiscordAuthError | DisallowedIntentsError | DiscordUnavailableError */
  connect(handlers: InteractionHandlers): Promise<void>;
  disconnect(): Promise<void>;
  latencyMs(): number | null;
  setGuildCommands(guildId: Snowflake, commands: readonly CommandDefinition[]): Promise<void>;
}

export interface Discord {
  gateway: DiscordGateway;
  bot: DiscordBotConnection;
}

/** Builds the port for one bot token (the wizard checks a token before it is stored). */
export type CreateDiscord = (token: string) => Discord;

export class DiscordAuthError extends Error {
  override name = 'DiscordAuthError';
}
export class DiscordUnavailableError extends Error {
  override name = 'DiscordUnavailableError';
}
export class DisallowedIntentsError extends Error {
  override name = 'DisallowedIntentsError';
}
