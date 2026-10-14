/**
 * An in-memory Discord behind the `DiscordGateway` port (ADR-0003): applications, guilds, roles, members,
 * channels with permission overwrites, threads, messages and the bot's gateway session. Tests build the state
 * they need; nothing is shared between fakes.
 *
 * Permissions follow Discord's resolution order through the shared resolver, and writes are refused the way
 * Discord refused them in spike S3. Both are checked against S3's recorded cases (test/contract).
 */
import type { Member } from '../../../../shared/access/access';
import { type Overwrite, targetKey } from '../../../../shared/discord/overwrites';
import { PERMISSION_BITS } from '../../../../shared/discord/permissions';
import { effectivePermissions } from '../../../../shared/discord/resolve';
import {
  type ApplicationInfo,
  type ChannelState,
  type CommandDefinition,
  type CreateDiscord,
  type DisconnectReason,
  type DiscordBotConnection,
  type DiscordGateway,
  type GuildInfo,
  type GuildMember,
  type GuildRole,
  type InboundInteraction,
  type InteractionHandlers,
  type InteractionReply,
  DisallowedIntentsError,
  DiscordAuthError,
  DiscordPermissionError,
  DiscordUnavailableError,
} from '../port';

export interface FakeApplication extends ApplicationInfo {
  botUserId: string;
  /** What the OAuth token exchange accepts (the HTTP fake). */
  clientSecret?: string;
}

export interface FakeProfile {
  displayName: string;
  username: string;
  bot: boolean;
}

export interface FakeGuild {
  id: string;
  name: string;
  ownerId: string;
  /** Includes `@everyone`, whose ID is the guild's and whose position is 0. */
  roles: GuildRole[];
  /** user ID → role IDs (without `@everyone`). */
  members: Map<string, string[]>;
  profiles: Map<string, FakeProfile>;
}

export interface FakeChannel extends ChannelState {
  guildId: string;
}

export interface FakeThread {
  id: string;
  channelId: string;
  type: 'public' | 'private';
  archived: boolean;
  memberIds: string[];
}

export interface FakeMessage {
  id: string;
  channelId: string;
  content: string;
  buttons: { customId: string; label: string }[];
  pinned: boolean;
}

export type ConnectFailure = 'invalid_token' | 'disallowed_intents' | 'unavailable';
/** `unavailable`: nothing applied. `lost_answer`: applied, then the answer is lost. */
export type WriteFailure = 'unavailable' | 'lost_answer';

export interface MutationRecord {
  method: string;
  target: string;
}

export interface FakeDiscord {
  readonly applications: Map<string, FakeApplication>;
  /** token → application ID */
  readonly tokens: Map<string, string>;
  readonly guilds: Map<string, FakeGuild>;
  readonly channels: Map<string, FakeChannel>;
  readonly threads: Map<string, FakeThread>;
  readonly messages: Map<string, FakeMessage>;
  /** guild ID → the commands registered there. */
  readonly commands: Map<string, readonly CommandDefinition[]>;
  /** Every mutating call that reached the fake, applied or refused, in order. */
  readonly mutations: MutationRecord[];
  /** Every REST call fails as if Discord were down. */
  unavailable: boolean;
  /** While set, every REST read waits for it: lets a test hold a request mid-flight. */
  readGate: Promise<void> | null;
  /** While set, every mutating call waits for it, then is checked and applied against the state at release. */
  writeGate: Promise<void> | null;
  /** The next gateway logins fail this way (`null`: they succeed). */
  connectFailure: ConnectFailure | null;
  connectAttempts: number;
  connected: boolean;

  addApplication(app: Partial<FakeApplication> & { id: string; token: string }): FakeApplication;
  addGuild(guild: { id: string; name: string; everyonePermissions?: bigint; ownerId?: string }): FakeGuild;
  addRole(guildId: string, role: Partial<GuildRole> & { id: string }): GuildRole;
  addMember(guildId: string, userId: string, roleIds?: string[], profile?: Partial<FakeProfile>): void;
  removeMember(guildId: string, userId: string): void;
  /** Invites the application's bot into the guild with a managed role holding `permissions`. */
  inviteBot(appId: string, guildId: string, opts?: { permissions?: bigint; position?: number }): void;
  /** The next mutating calls fail this way, one per entry. */
  failNext(...failures: WriteFailure[]): void;
  /**
   * Called synchronously at every mutating call, with its index in `mutations`, before Discord's rules are checked:
   * it may fail the call, or change the fake's state the call is then checked against. `null` clears it.
   */
  failOn(rule: ((call: MutationRecord, index: number) => WriteFailure | null | undefined) | null): void;
  /** Replaces a channel's overwrites as an administrator would: no bot permission rules. */
  forceOverwrites(channelId: string, overwrites: Overwrite[]): void;
  addThread(channelId: string, thread: { type: 'public' | 'private'; archived?: boolean; memberIds?: string[] }): string;
  /** A member's effective permissions in a channel or one of its threads. */
  permissionsFor(userId: string, channelId: string, threadId?: string): bigint;
  /** The guild's channels under a parent (or every channel). */
  channelsOf(guildId: string, parentId?: string | null): FakeChannel[];
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
  const channels = new Map<string, FakeChannel>();
  const threads = new Map<string, FakeThread>();
  const messages = new Map<string, FakeMessage>();
  const commands = new Map<string, readonly CommandDefinition[]>();
  const mutations: MutationRecord[] = [];
  const pendingFailures: WriteFailure[] = [];
  let rule: ((call: MutationRecord, index: number) => WriteFailure | null | undefined) | null = null;
  let handlers: InteractionHandlers | null = null;
  let counter = 900_000_000_000_000_000n;
  const snowflake = () => (++counter).toString();

  const fake: FakeDiscord = {
    applications,
    tokens,
    guilds,
    channels,
    threads,
    messages,
    commands,
    mutations,
    unavailable: false,
    readGate: null,
    writeGate: null,
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
    addGuild({ id, name, everyonePermissions = 0n, ownerId = '0' }) {
      const guild: FakeGuild = {
        id,
        name,
        ownerId,
        roles: [{ id, name: '@everyone', position: 0, managed: false, permissions: everyonePermissions }],
        members: new Map(),
        profiles: new Map(),
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
    addMember(guildId, userId, roleIds = [], profile = {}) {
      const guild = need(guilds.get(guildId));
      guild.members.set(userId, [...roleIds]);
      const username = profile.username ?? `user${userId.slice(-4)}`;
      guild.profiles.set(userId, { displayName: profile.displayName ?? username, username, bot: profile.bot ?? false });
    },
    removeMember(guildId, userId) {
      const guild = need(guilds.get(guildId));
      guild.members.delete(userId);
      guild.profiles.delete(userId);
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
      fake.addMember(guildId, app.botUserId, [roleId], { username: 'Genie', bot: true });
    },
    failNext(...failures) {
      pendingFailures.push(...failures);
    },
    failOn(next) {
      rule = next;
    },
    forceOverwrites(channelId, overwrites) {
      need(channels.get(channelId)).overwrites = overwrites.map(copy);
    },
    addThread(channelId, thread) {
      need(channels.get(channelId));
      const id = snowflake();
      threads.set(id, { id, channelId, type: thread.type, archived: thread.archived ?? false, memberIds: [...(thread.memberIds ?? [])] });
      return id;
    },
    permissionsFor(userId, channelId, threadId) {
      const channel = need(channels.get(channelId));
      const guild = need(guilds.get(channel.guildId));
      const roleIds = guild.members.get(userId);
      if (!roleIds) return 0n;
      const thread = threadId === undefined ? undefined : need(threads.get(threadId));
      return effectivePermissions({
        guildId: guild.id,
        guildOwnerId: guild.ownerId,
        roles: guild.roles,
        member: { userId, roleIds },
        channel: { overwrites: channel.overwrites },
        ...(thread ? { thread: { type: thread.type, archived: thread.archived, memberIds: thread.memberIds } } : {}),
      });
    },
    channelsOf(guildId, parentId) {
      return [...channels.values()].filter((c) => c.guildId === guildId && (parentId === undefined || c.parentId === parentId));
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
      const read = async () => {
        await fake.readGate;
        return appOf();
      };
      const botGuild = (guildId: string): FakeGuild => {
        const app = appOf();
        const guild = guilds.get(guildId);
        if (!guild?.members.has(app.botUserId)) throw new DiscordUnavailableError('The bot is not in the guild (fake).');
        return guild;
      };

      /**
       * A mutating call: waits on the write gate, then fails as injected, or checks the S3 rules against the state
       * at that moment and applies `apply`. A `lost_answer` applies and then throws.
       */
      async function write<T>(method: string, target: string, guildId: string, overwrites: readonly Overwrite[] | null, existing: readonly Overwrite[] | null, apply: () => T): Promise<T> {
        await fake.writeGate;
        const app = appOf();
        const call = { method, target };
        mutations.push(call);
        const failure = rule?.(call, mutations.length - 1) || pendingFailures.shift();
        if (failure === 'unavailable') throw new DiscordUnavailableError(`${method} failed (fake, injected).`);
        if (overwrites) refuseUnlessAllowed(botGuild(guildId), app.botUserId, overwrites, existing ?? []);
        const result = apply();
        if (failure === 'lost_answer') throw new DiscordUnavailableError(`${method}: the answer was lost (fake, injected).`);
        return result;
      }

      const member = (guild: FakeGuild, userId: string): GuildMember => {
        const profile = guild.profiles.get(userId) ?? { displayName: userId, username: userId, bot: false };
        return { userId, roleIds: [...(guild.members.get(userId) ?? [])], ...profile };
      };

      const gateway: DiscordGateway = {
        async getApplication() {
          const { id, botPublic, flags } = await read();
          return { id, botPublic, flags };
        },
        async listGuilds() {
          const app = await read();
          return [...guilds.values()].filter((g) => g.members.has(app.botUserId)).map((g) => ({ id: g.id, name: g.name }));
        },
        async getGuild(guildId) {
          const app = await read();
          const guild = guilds.get(guildId);
          if (!guild?.members.has(app.botUserId)) return null;
          return guildInfo(guild, app.botUserId, fake.channelsOf(guildId).length);
        },
        async getMember(guildId, userId): Promise<Member | null> {
          await read();
          const guild = botGuild(guildId);
          const roleIds = guild.members.get(userId);
          return roleIds ? { userId, roleIds: [...roleIds] } : null;
        },
        async listMembers(guildId) {
          await read();
          const guild = botGuild(guildId);
          return [...guild.members.keys()].map((id) => member(guild, id));
        },
        async searchMembers(guildId, query, limit) {
          await read();
          const guild = botGuild(guildId);
          const q = query.toLowerCase();
          return [...guild.members.keys()]
            .map((id) => member(guild, id))
            .filter((m) => m.username.toLowerCase().startsWith(q) || m.displayName.toLowerCase().startsWith(q))
            .slice(0, limit);
        },
        async createCategory(guildId, spec) {
          return write('createCategory', spec.name, guildId, spec.overwrites, [], () => {
            const id = snowflake();
            channels.set(id, { id, guildId, type: 'category', name: spec.name, parentId: null, topic: null, position: channels.size, overwrites: spec.overwrites.map(copy) });
            return id;
          });
        },
        async createChannel(guildId, spec) {
          const parent = need(channels.get(spec.parentId));
          return write('createChannel', spec.name, guildId, spec.overwrites ?? null, [], () => {
            const id = snowflake();
            const overwrites = spec.overwrites === undefined ? parent.overwrites.map(copy) : spec.overwrites.map(copy);
            channels.set(id, { id, guildId, type: 'text', name: spec.name, parentId: spec.parentId, topic: spec.topic ?? null, position: spec.position ?? channels.size, overwrites });
            return id;
          });
        },
        async updateChannel(channelId, patch) {
          const channel = channels.get(channelId);
          if (!channel) throw new DiscordUnavailableError('Unknown channel (fake).');
          await write('updateChannel', channelId, channel.guildId, null, null, () => {
            if (patch.name !== undefined) channel.name = patch.name;
            if (patch.topic !== undefined) channel.topic = patch.topic;
            if (patch.parentId !== undefined) channel.parentId = patch.parentId;
            if (patch.position !== undefined) channel.position = patch.position;
          });
        },
        async setOverwrites(channelId, overwrites) {
          const channel = channels.get(channelId);
          if (!channel) throw new DiscordUnavailableError('Unknown channel (fake).');
          await write('setOverwrites', channelId, channel.guildId, overwrites, channel.overwrites, () => {
            channel.overwrites = overwrites.map(copy);
          });
        },
        async getChannel(channelId) {
          await read();
          const channel = channels.get(channelId);
          return channel ? view(channel) : null;
        },
        async listChannels(guildId) {
          await read();
          botGuild(guildId);
          return fake.channelsOf(guildId).map(view);
        },
        async deleteChannel(channelId) {
          const channel = channels.get(channelId);
          if (!channel) {
            await read();
            return 'already_gone';
          }
          return write('deleteChannel', channelId, channel.guildId, null, null, () => {
            channels.delete(channelId);
            // Like Discord, deleting a category leaves its channels in place, without a parent.
            for (const child of channels.values()) if (child.parentId === channelId) child.parentId = null;
            return 'deleted' as const;
          });
        },
        async postMessage(channelId, msg) {
          const channel = channels.get(channelId);
          if (!channel) throw new DiscordUnavailableError('Unknown channel (fake).');
          return write('postMessage', channelId, channel.guildId, null, null, () => {
            const id = snowflake();
            messages.set(id, { id, channelId, content: msg.content, buttons: [...(msg.buttons ?? [])], pinned: false });
            return id;
          });
        },
        async pinMessage(channelId, messageId) {
          const channel = channels.get(channelId);
          if (!channel) throw new DiscordUnavailableError('Unknown channel (fake).');
          await write('pinMessage', messageId, channel.guildId, null, null, () => {
            need(messages.get(messageId)).pinned = true;
          });
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

/**
 * Discord's rules for a bot without Administrator writing overwrites, as spike S3 recorded them (ADR-0012):
 * it needs Manage Roles at all, it can only allow or deny what it holds, and it can't put Manage Roles in an
 * overwrite unless the channel already gives it Manage Roles.
 */
function refuseUnlessAllowed(guild: FakeGuild, botUserId: string, overwrites: readonly Overwrite[], existing: readonly Overwrite[]): void {
  const base = effectivePermissions({
    guildId: guild.id,
    guildOwnerId: guild.ownerId,
    roles: guild.roles,
    member: { userId: botUserId, roleIds: guild.members.get(botUserId) ?? [] },
    channel: null,
  });
  if (base & PERMISSION_BITS.Administrator) return;
  if (overwrites.length === 0) return;
  if (!(base & PERMISSION_BITS.ManageRoles)) throw new DiscordPermissionError('Missing Permissions (fake): Manage Roles.');
  for (const o of overwrites) {
    if ((o.allow | o.deny) & ~base) throw new DiscordPermissionError(`Missing Permissions (fake): ${targetKey(o.target)} uses bits the bot lacks.`);
  }
  const grantsManageRoles = overwrites.some((o) => o.allow & PERMISSION_BITS.ManageRoles);
  const alreadyHas = existing.some((o) => o.target.kind === 'member' && o.target.id === botUserId && o.allow & PERMISSION_BITS.ManageRoles);
  if (grantsManageRoles && !alreadyHas) throw new DiscordPermissionError('Missing Permissions (fake): Manage Roles in an overwrite.');
}

const copy = (o: Overwrite): Overwrite => ({ target: { ...o.target }, allow: o.allow, deny: o.deny });

function view(channel: FakeChannel): ChannelState {
  const { guildId: _guildId, ...state } = channel;
  return { ...state, overwrites: state.overwrites.map(copy) };
}

function guildInfo(guild: FakeGuild, botUserId: string, channelCount: number): GuildInfo {
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
    botUserId,
    ownerId: guild.ownerId,
    channelCount,
  };
}

function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Not in the fake Discord.');
  return value;
}
