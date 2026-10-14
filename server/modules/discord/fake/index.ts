/**
 * An in-memory Discord behind the `DiscordGateway` port (ADR-0003): applications, guilds, roles, members and
 * the bot's gateway session. Tests build the state they need; nothing is shared between fakes.
 *
 * M1 models what the setup wizard, login and the bot runner read. The permission model of §4.1 (overwrites,
 * the S3 contract suite) arrives with M2.
 */
import type { Member } from '../../../../shared/access/access';
import {
  type ApplicationInfo,
  type CommandDefinition,
  type CreateDiscord,
  type DisconnectReason,
  type DiscordBotConnection,
  type DiscordGateway,
  type GuildInfo,
  type GuildRole,
  type InboundInteraction,
  type InteractionHandlers,
  type InteractionReply,
  DisallowedIntentsError,
  DiscordAuthError,
  DiscordUnavailableError,
} from '../port';

export interface FakeApplication extends ApplicationInfo {
  botUserId: string;
}

export interface FakeGuild {
  id: string;
  name: string;
  /** Includes `@everyone`, whose ID is the guild's and whose position is 0. */
  roles: GuildRole[];
  /** user ID → role IDs (without `@everyone`). */
  members: Map<string, string[]>;
}

export type ConnectFailure = 'invalid_token' | 'disallowed_intents' | 'unavailable';

export interface FakeDiscord {
  readonly applications: Map<string, FakeApplication>;
  /** token → application ID */
  readonly tokens: Map<string, string>;
  readonly guilds: Map<string, FakeGuild>;
  /** guild ID → the commands registered there. */
  readonly commands: Map<string, readonly CommandDefinition[]>;
  /** Every REST read fails as if Discord were down. */
  unavailable: boolean;
  /** The next gateway logins fail this way (`null`: they succeed). */
  connectFailure: ConnectFailure | null;
  connectAttempts: number;
  connected: boolean;

  addApplication(app: Partial<FakeApplication> & { id: string; token: string }): FakeApplication;
  addGuild(guild: { id: string; name: string; everyonePermissions?: bigint }): FakeGuild;
  addRole(guildId: string, role: Partial<GuildRole> & { id: string }): GuildRole;
  addMember(guildId: string, userId: string, roleIds?: string[]): void;
  removeMember(guildId: string, userId: string): void;
  /** Invites the application's bot into the guild with a managed role holding `permissions`. */
  inviteBot(appId: string, guildId: string, opts?: { permissions?: bigint; position?: number }): void;
  /** Ends the bot's session the way an unrecoverable gateway close does. */
  dropConnection(reason: DisconnectReason): void;
  /** Sends an interaction to the connected bot; resolves with its ephemeral replies. */
  dispatch(interaction: InboundInteraction): Promise<string[]>;
  create: CreateDiscord;
}

export function createFakeDiscord(): FakeDiscord {
  const applications = new Map<string, FakeApplication>();
  const tokens = new Map<string, string>();
  const guilds = new Map<string, FakeGuild>();
  const commands = new Map<string, readonly CommandDefinition[]>();
  let handlers: InteractionHandlers | null = null;

  const fake: FakeDiscord = {
    applications,
    tokens,
    guilds,
    commands,
    unavailable: false,
    connectFailure: null,
    connectAttempts: 0,
    connected: false,

    addApplication({ token, ...app }) {
      const full: FakeApplication = {
        botPublic: false,
        flags: (1 << 14) | (1 << 18),
        botUserId: `${app.id}9`,
        ...app,
      };
      applications.set(full.id, full);
      tokens.set(token, full.id);
      return full;
    },
    addGuild({ id, name, everyonePermissions = 0n }) {
      const guild: FakeGuild = {
        id,
        name,
        roles: [{ id, name: '@everyone', position: 0, managed: false, permissions: everyonePermissions }],
        members: new Map(),
      };
      guilds.set(id, guild);
      return guild;
    },
    addRole(guildId, role) {
      const guild = need(guilds.get(guildId));
      const full: GuildRole = { name: role.id, position: guild.roles.length, managed: false, permissions: 0n, ...role };
      guild.roles.push(full);
      return full;
    },
    addMember(guildId, userId, roleIds = []) {
      need(guilds.get(guildId)).members.set(userId, [...roleIds]);
    },
    removeMember(guildId, userId) {
      need(guilds.get(guildId)).members.delete(userId);
    },
    inviteBot(appId, guildId, opts = {}) {
      const app = need(applications.get(appId));
      const roleId = `${app.id}-role-${guildId}`;
      fake.addRole(guildId, {
        id: roleId,
        name: 'Genie',
        managed: true,
        permissions: opts.permissions ?? 0n,
        ...(opts.position === undefined ? {} : { position: opts.position }),
      });
      fake.addMember(guildId, app.botUserId, [roleId]);
    },
    dropConnection(reason) {
      const current = handlers;
      handlers = null;
      fake.connected = false;
      current?.onDisconnected?.(reason);
    },
    async dispatch(interaction) {
      if (!handlers) throw new Error('The bot is not connected.');
      const sent: string[] = [];
      const reply: InteractionReply = { ephemeral: async (text) => void sent.push(text) };
      await handlers.onInteraction(interaction, reply);
      return sent;
    },
    create(token) {
      const appOf = (): FakeApplication => {
        if (fake.unavailable) throw new DiscordUnavailableError('Discord is unavailable (fake).');
        const id = tokens.get(token);
        if (!id) throw new DiscordAuthError('401: Unauthorized (fake).');
        return need(applications.get(id));
      };
      const gateway: DiscordGateway = {
        async getApplication() {
          const { botUserId: _bot, ...info } = appOf();
          return { ...info };
        },
        async listGuilds() {
          const app = appOf();
          return [...guilds.values()].filter((g) => g.members.has(app.botUserId)).map((g) => ({ id: g.id, name: g.name }));
        },
        async getGuild(guildId) {
          const app = appOf();
          const guild = guilds.get(guildId);
          if (!guild?.members.has(app.botUserId)) return null;
          return guildInfo(guild, app.botUserId);
        },
        async getMember(guildId, userId): Promise<Member | null> {
          const app = appOf();
          const guild = guilds.get(guildId);
          if (!guild?.members.has(app.botUserId)) throw new DiscordUnavailableError('The bot is not in the guild (fake).');
          const roleIds = guild.members.get(userId);
          return roleIds ? { userId, roleIds: [...roleIds] } : null;
        },
      };
      const bot: DiscordBotConnection = {
        async connect(h) {
          fake.connectAttempts += 1;
          const failure = fake.connectFailure;
          if (failure === 'invalid_token' || !tokens.has(token)) throw new DiscordAuthError('An invalid token was provided (fake).');
          if (failure === 'disallowed_intents') throw new DisallowedIntentsError('Used disallowed intents (fake).');
          if (failure === 'unavailable' || fake.unavailable) throw new DiscordUnavailableError('Gateway unavailable (fake).');
          handlers = h;
          fake.connected = true;
        },
        async disconnect() {
          handlers = null;
          fake.connected = false;
        },
        latencyMs: () => (fake.connected ? 42 : null),
        async setGuildCommands(guildId, list) {
          commands.set(guildId, [...list]);
        },
      };
      return { gateway, bot };
    },
  };
  return fake;
}

function guildInfo(guild: FakeGuild, botUserId: string): GuildInfo {
  const botRoleIds = guild.members.get(botUserId) ?? [];
  const everyone = guild.roles.find((r) => r.id === guild.id);
  const botRoles = guild.roles.filter((r) => botRoleIds.includes(r.id));
  return {
    id: guild.id,
    name: guild.name,
    roles: guild.roles.map((r) => ({ ...r })),
    botRoleIds: [...botRoleIds],
    botHighestRolePosition: Math.max(0, ...botRoles.map((r) => r.position)),
    botPermissions: botRoles.reduce((bits, r) => bits | r.permissions, everyone?.permissions ?? 0n),
  };
}

function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Not in the fake Discord.');
  return value;
}
