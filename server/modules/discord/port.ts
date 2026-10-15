/**
 * The only way modules reach Discord (ADR-0003). Only `adapters/discordjs/` implements it against Discord;
 * `fake/` implements it in memory for tests. Payload shapes never cross this boundary.
 *
 * M1 has the application, guild and member reads the setup wizard and login need, plus the gateway
 * connection. M2 adds members, channels, overwrites and messages. Threads and history arrive with close-out.
 */
import type { Member } from '../../../shared/access/access';
import type { Overwrite } from '../../../shared/discord/overwrites';

export type Snowflake = string;
export type { Overwrite };

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
  botUserId: Snowflake;
  ownerId: Snowflake;
  channelCount: number;
}

export type { Member };

export interface GuildMember {
  userId: Snowflake;
  roleIds: Snowflake[];
  /** The server nickname, else the global name, else the username. */
  displayName: string;
  username: string;
  bot: boolean;
}

export interface ChannelState {
  id: Snowflake;
  type: 'category' | 'text' | 'other';
  name: string;
  parentId: Snowflake | null;
  topic: string | null;
  position: number;
  overwrites: Overwrite[];
}

export interface OutboundMessage {
  content: string;
  buttons?: { customId: string; label: string }[];
}

export interface DiscordGateway {
  /** @throws DiscordAuthError for a token Discord refuses; DiscordUnavailableError when Discord can't answer. */
  getApplication(): Promise<ApplicationInfo>;
  listGuilds(): Promise<{ id: Snowflake; name: string }[]>;
  /** `null` when the bot isn't in the guild. */
  getGuild(guildId: Snowflake): Promise<GuildInfo | null>;
  /** `null` when the user isn't a member. */
  getMember(guildId: Snowflake, userId: Snowflake): Promise<Member | null>;
  /** Every member, paged by the adapter. */
  listMembers(guildId: Snowflake): Promise<GuildMember[]>;
  searchMembers(guildId: Snowflake, query: string, limit: number): Promise<GuildMember[]>;

  // Writes. A refusal (403, code 50013) throws DiscordPermissionError.
  createCategory(guildId: Snowflake, spec: { name: string; overwrites: Overwrite[] }): Promise<Snowflake>;
  /** Text channels only. With `overwrites` omitted (not `[]`), the channel copies its category's. */
  createChannel(guildId: Snowflake, spec: { name: string; parentId: Snowflake; topic?: string | null; position?: number; overwrites?: Overwrite[] }): Promise<Snowflake>;
  /** Never syncs the channel to its new category's overwrites. */
  updateChannel(channelId: Snowflake, patch: { name?: string; topic?: string | null; parentId?: Snowflake; position?: number }): Promise<void>;
  /** Replaces the whole list. */
  setOverwrites(channelId: Snowflake, overwrites: Overwrite[]): Promise<void>;
  /** `null` once deleted. */
  getChannel(channelId: Snowflake): Promise<ChannelState | null>;
  listChannels(guildId: Snowflake): Promise<ChannelState[]>;
  deleteChannel(channelId: Snowflake, reason: string): Promise<'deleted' | 'already_gone'>;
  postMessage(channelId: Snowflake, msg: OutboundMessage): Promise<Snowflake>;
  pinMessage(channelId: Snowflake, messageId: Snowflake): Promise<void>;
}

/** An interaction in Genie's terms; the adapter builds it from discord.js's. */
export interface InboundInteraction {
  id: Snowflake;
  kind: 'command' | 'component' | 'modal';
  name: string;
  guildId: Snowflake | null;
  channelId: Snowflake | null;
  userId: Snowflake;
  /** The command's options by name (empty for components and modals). */
  options: Record<string, string | number | boolean>;
  /** The caller's roles in the guild (empty in DMs). */
  memberRoleIds: Snowflake[];
  userDisplayName: string;
}

export interface InteractionReply {
  ephemeral(text: string): Promise<void>;
}

export interface CommandOption {
  name: string;
  description: string;
  type: 'string';
  required: boolean;
}

export interface CommandDefinition {
  name: string;
  description: string;
  options?: CommandOption[];
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
/** Discord refused a write the bot lacks the permissions for (403, code 50013). */
export class DiscordPermissionError extends Error {
  override name = 'DiscordPermissionError';
  readonly code = 50013;
}
