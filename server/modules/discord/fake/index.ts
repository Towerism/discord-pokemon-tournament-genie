/**
 * An in-memory Discord behind the `DiscordGateway` port (ADR-0003): applications, guilds, roles, members,
 * channels with permission overwrites, threads, messages and the bot's gateway session. Tests build the state
 * they need; nothing is shared between fakes.
 *
 * Permissions follow Discord's resolution order through the shared resolver, and writes are refused the way
 * Discord refused them in spike S3. Both are checked against S3's recorded cases (test/contract).
 */
import type { Member } from '../../../../shared/access/access';
import type { Overwrite } from '../../../../shared/discord/overwrites';
import { PERMISSION_BITS } from '../../../../shared/discord/permissions';
import { effectivePermissions } from '../../../../shared/discord/resolve';
import { writeRefusal } from '../../../../shared/discord/write-rules';
import {
  type ApplicationInfo,
  type AutocompleteChoice,
  type ChannelState,
  type Embed,
  type MessageButton,
  type ModalSpec,
  type CommandDefinition,
  type CreateDiscord,
  type DisconnectReason,
  type DiscordBotConnection,
  type DiscordGateway,
  type GuildInfo,
  type GuildMember,
  type GuildRole,
  type HistoryEmbed,
  type HistoryMessage,
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
  name: string;
  type: 'public' | 'private';
  archived: boolean;
  memberIds: string[];
}

export interface FakeAttachment {
  id: string;
  filename: string;
  size: number;
  contentType: string | null;
  data: Buffer;
}

export interface FakeMessage {
  id: string;
  /** The channel, or the thread, that holds it. */
  channelId: string;
  authorId: string;
  content: string;
  /** The bot's card. */
  embed: Embed | null;
  /** Embeds a member's message carries. */
  embeds: HistoryEmbed[];
  attachments: FakeAttachment[];
  referencedMessageId: string | null;
  createdAt: number;
  editedAt: number | null;
  buttons: MessageButton[];
  pinned: boolean;
}

/** How the fake CDN answers one attachment, instead of serving it. */
export type CdnBehaviour = 'error' | 'redirect' | 'overlong' | 'stall';

export interface CdnAnswer {
  status: number;
  body?: Buffer;
  /** For a redirect. */
  location?: string;
  /** Overlong: the body is longer than the attachment's size; stall: it never finishes. */
  behaviour?: CdnBehaviour;
}

/** Everything a handler answered to one interaction. */
export interface InteractionOutcome {
  ephemeral: string[];
  /** The buttons sent with the last ephemeral reply. */
  buttons: MessageButton[];
  deferred: boolean;
  modal: ModalSpec | null;
  choices: AutocompleteChoice[] | null;
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
  /** Every REST call that reached the fake, reads and writes alike. */
  restCalls: number;
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
  addThread(channelId: string, thread: { type: 'public' | 'private'; archived?: boolean; memberIds?: string[]; name?: string }): string;
  /** A member opens a thread, if Discord would let them (Create Public/Private Threads). */
  openThread(userId: string, channelId: string, thread: { type: 'public' | 'private'; name: string }): string;
  /** A member posts in a channel or thread, if Discord would let them (Send Messages, or Send Messages in Threads). */
  post(
    userId: string,
    channelOrThreadId: string,
    msg: { content?: string; embeds?: HistoryEmbed[]; attachments?: { filename: string; data: Buffer; contentType?: string }[]; replyTo?: string },
  ): string;
  /** A member edits their own message. */
  editAsAuthor(messageId: string, content: string): void;
  /** The clock messages, edits and CDN URLs are timed by. */
  setNow(now: () => number): void;
  /** Where resolved attachment URLs point (`https://cdn.discordapp.com` unless a test serves the CDN itself). */
  cdnBase: string;
  /** Attachment ID → how the CDN misbehaves for it. */
  readonly cdnBehaviour: Map<string, CdnBehaviour>;
  /** Every CDN path requested. */
  readonly cdnRequests: string[];
  /** The CDN's answer to a URL: the file while its URL is valid, 404 once it expired. */
  cdnServe(url: string): CdnAnswer;
  /** A member's effective permissions in a channel or one of its threads. */
  permissionsFor(userId: string, channelId: string, threadId?: string): bigint;
  /** The guild's channels under a parent (or every channel). */
  channelsOf(guildId: string, parentId?: string | null): FakeChannel[];
  /** Ends the bot's session the way an unrecoverable gateway close does. */
  dropConnection(reason: DisconnectReason): void;
  /** Sends an interaction to the connected bot; resolves with its ephemeral replies. */
  dispatch(interaction: InboundInteraction): Promise<string[]>;
  /** Sends an interaction to the connected bot; resolves with everything it answered. */
  interact(interaction: InboundInteraction): Promise<InteractionOutcome>;
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
  let now = () => 1_760_000_000_000;
  const cdnBehaviour = new Map<string, CdnBehaviour>();
  const cdnRequests: string[] = [];
  /** URL lifetime, as S4 recorded it: about 24 hours. */
  const URL_LIFETIME_MS = 86_400_000;
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
    restCalls: 0,
    unavailable: false,
    readGate: null,
    writeGate: null,
    connectFailure: null,
    connectAttempts: 0,
    connected: false,
    cdnBase: 'https://cdn.discordapp.com',
    cdnBehaviour,
    cdnRequests,

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
      threads.set(id, { id, channelId, name: thread.name ?? `thread-${id.slice(-4)}`, type: thread.type, archived: thread.archived ?? false, memberIds: [...(thread.memberIds ?? [])] });
      return id;
    },
    openThread(userId, channelId, thread) {
      const needed = thread.type === 'public' ? PERMISSION_BITS.CreatePublicThreads : PERMISSION_BITS.CreatePrivateThreads;
      if (!(fake.permissionsFor(userId, channelId) & needed)) throw new DiscordPermissionError(`Missing Permissions (fake): ${userId} can't open a thread.`);
      return fake.addThread(channelId, { type: thread.type, name: thread.name, memberIds: [userId] });
    },
    post(userId, target, msg) {
      const thread = threads.get(target);
      const channelId = thread ? thread.channelId : target;
      need(channels.get(channelId));
      const bits = fake.permissionsFor(userId, channelId, thread?.id);
      const needed = thread ? PERMISSION_BITS.SendMessagesInThreads : PERMISSION_BITS.SendMessages;
      if (!(bits & PERMISSION_BITS.ViewChannel) || !(bits & needed)) throw new DiscordPermissionError(`Missing Permissions (fake): ${userId} can't post here.`);
      const id = snowflake();
      messages.set(id, {
        id,
        channelId: target,
        authorId: userId,
        content: msg.content ?? '',
        embed: null,
        embeds: (msg.embeds ?? []).map((e) => structuredClone(e)),
        attachments: (msg.attachments ?? []).map((a) => ({ id: snowflake(), filename: a.filename, size: a.data.length, contentType: a.contentType ?? null, data: a.data })),
        referencedMessageId: msg.replyTo ?? null,
        createdAt: now(),
        editedAt: null,
        buttons: [],
        pinned: false,
      });
      return id;
    },
    editAsAuthor(messageId, content) {
      const message = need(messages.get(messageId));
      message.content = content;
      message.editedAt = now() + 1;
    },
    setNow(next) {
      now = next;
    },
    cdnServe(url) {
      const parsed = new URL(url);
      cdnRequests.push(parsed.pathname);
      const match = /^\/attachments\/(\d+)\/(\d+)\/[^/]+$/.exec(parsed.pathname);
      const expires = Number.parseInt(parsed.searchParams.get('ex') ?? '', 16);
      if (!match || !Number.isFinite(expires) || expires * 1000 < now()) return { status: 404 };
      const message = [...messages.values()].find((m) => m.channelId === match[1] && m.attachments.some((a) => a.id === match[2]));
      const attachment = message?.attachments.find((a) => a.id === match[2]);
      if (!attachment) return { status: 404 };
      const behaviour = cdnBehaviour.get(attachment.id);
      if (behaviour === 'error') return { status: 500 };
      if (behaviour === 'redirect') return { status: 302, location: `${fake.cdnBase}/elsewhere` };
      if (behaviour) return { status: 200, body: attachment.data, behaviour };
      return { status: 200, body: attachment.data };
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
      return (await fake.interact(interaction)).ephemeral;
    },
    async interact(interaction) {
      if (!handlers) throw new Error('The bot is not connected.');
      const outcome: InteractionOutcome = { ephemeral: [], buttons: [], deferred: false, modal: null, choices: null };
      const reply: InteractionReply = {
        ephemeral: async (text, opts) => {
          outcome.ephemeral.push(text);
          outcome.buttons = (opts?.buttons ?? []).map((b) => ({ ...b }));
        },
        deferEphemeral: async () => void (outcome.deferred = true),
        showModal: async (modal) => void (outcome.modal = structuredClone(modal)),
        autocomplete: async (choices) => void (outcome.choices = [...choices]),
      };
      await handlers.onInteraction(interaction, reply);
      return outcome;
    },
    create(token) {
      const appOf = (): FakeApplication => {
        if (fake.unavailable) throw new DiscordUnavailableError('Discord is unavailable (fake).');
        const id = tokens.get(token);
        if (!id) throw new DiscordAuthError('401: Unauthorized (fake).');
        return need(applications.get(id));
      };
      const read = async () => {
        fake.restCalls += 1;
        await fake.readGate;
        return appOf();
      };
      /** A channel, or a thread with its parent channel; `null` once either is gone. */
      const locate = (id: string): { channel: FakeChannel; thread: FakeThread | null } | null => {
        const thread = threads.get(id);
        const channel = channels.get(thread ? thread.channelId : id);
        return channel ? { channel, thread: thread ?? null } : null;
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
        fake.restCalls += 1;
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
            messages.set(id, {
              id,
              channelId,
              authorId: appOf().botUserId,
              content: msg.content,
              embed: msg.embed ? structuredClone(msg.embed) : null,
              embeds: [],
              attachments: [],
              referencedMessageId: null,
              createdAt: now(),
              editedAt: null,
              buttons: (msg.buttons ?? []).map((b) => ({ ...b })),
              pinned: false,
            });
            return id;
          });
        },
        async editMessage(channelId, messageId, msg) {
          const channel = channels.get(channelId);
          if (!channel) {
            await read();
            return 'gone';
          }
          return write('editMessage', messageId, channel.guildId, null, null, () => {
            const message = messages.get(messageId);
            if (!message || message.channelId !== channelId) return 'gone' as const;
            message.content = msg.content;
            message.embed = msg.embed ? structuredClone(msg.embed) : null;
            message.editedAt = now();
            message.buttons = (msg.buttons ?? []).map((b) => ({ ...b }));
            return 'edited' as const;
          });
        },
        async deleteMessage(channelId, messageId) {
          const channel = channels.get(channelId);
          if (!channel) {
            await read();
            return 'already_gone';
          }
          return write('deleteMessage', messageId, channel.guildId, null, null, () => {
            const message = messages.get(messageId);
            if (!message || message.channelId !== channelId) return 'already_gone' as const;
            messages.delete(messageId);
            return 'deleted' as const;
          });
        },
        async pinMessage(channelId, messageId) {
          const channel = channels.get(channelId);
          if (!channel) throw new DiscordUnavailableError('Unknown channel (fake).');
          await write('pinMessage', messageId, channel.guildId, null, null, () => {
            // Discord requires Pin Messages for a pin; Manage Messages no longer counts (ADR-0016).
            const bits = fake.permissionsFor(appOf().botUserId, channelId);
            if (!(bits & PERMISSION_BITS.ViewChannel) || !(bits & PERMISSION_BITS.PinMessages)) throw new DiscordPermissionError('Missing Permissions (fake): pinning needs Pin Messages.');
            need(messages.get(messageId)).pinned = true;
          });
        },
        async readHistory(channelId, before) {
          const app = await read();
          const where = locate(channelId);
          if (!where) return null;
          const bits = fake.permissionsFor(app.botUserId, where.channel.id, where.thread?.id);
          if (!(bits & PERMISSION_BITS.ViewChannel) || !(bits & PERMISSION_BITS.ReadMessageHistory)) {
            throw new DiscordPermissionError('Missing Access (fake): the bot can’t read this history.');
          }
          return [...messages.values()]
            .filter((m) => m.channelId === channelId && (before === undefined || BigInt(m.id) < BigInt(before)))
            .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
            .slice(0, 100)
            .map((m) => historyOf(m, guilds.get(where.channel.guildId)!));
        },
        async listThreads(guildId, channelId) {
          const app = await read();
          botGuild(guildId);
          need(channels.get(channelId));
          if (!(fake.permissionsFor(app.botUserId, channelId) & PERMISSION_BITS.ManageThreads)) {
            throw new DiscordPermissionError('Missing Access (fake): listing archived private threads needs Manage Threads.');
          }
          return [...threads.values()]
            .filter((t) => t.channelId === channelId)
            .map((t) => ({ id: t.id, name: t.name, parentId: t.channelId, type: t.type, archived: t.archived }));
        },
        async getLatestMessageId(channelId) {
          await read();
          if (!locate(channelId)) return 'gone';
          let latest: string | null = null;
          for (const m of messages.values()) if (m.channelId === channelId && (latest === null || BigInt(m.id) > BigInt(latest))) latest = m.id;
          return latest;
        },
        async resolveAttachment(channelId, messageId, attachmentId) {
          await read();
          const message = messages.get(messageId);
          if (!message || message.channelId !== channelId) return { error: 'message_deleted' as const };
          const attachment = message.attachments.find((a) => a.id === attachmentId);
          if (!attachment) return { error: 'not_found' as const };
          const expires = Math.floor((now() + URL_LIFETIME_MS) / 1000).toString(16);
          const url = `${fake.cdnBase}/attachments/${channelId}/${attachment.id}/${encodeURIComponent(attachment.filename)}?ex=${expires}&is=${snowflake()}`;
          return { url, bytes: attachment.size };
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

/** Refuses a write the way Discord did in spike S3 (shared/discord/write-rules). */
function refuseUnlessAllowed(guild: FakeGuild, botUserId: string, overwrites: readonly Overwrite[], existing: readonly Overwrite[]): void {
  const base = effectivePermissions({
    guildId: guild.id,
    guildOwnerId: guild.ownerId,
    roles: guild.roles,
    member: { userId: botUserId, roleIds: guild.members.get(botUserId) ?? [] },
    channel: null,
  });
  const refusal = writeRefusal(base, botUserId, overwrites, existing);
  if (refusal) throw new DiscordPermissionError(`Missing Permissions (fake): ${refusal}.`);
}

const copy = (o: Overwrite): Overwrite => ({ target: { ...o.target }, allow: o.allow, deny: o.deny });

function historyOf(m: FakeMessage, guild: FakeGuild): HistoryMessage {
  const profile = guild.profiles.get(m.authorId);
  const card: HistoryEmbed[] = m.embed ? [{ title: m.embed.title, description: m.embed.footer ?? null, url: null, fields: m.embed.fields.map((f) => ({ ...f })) }] : [];
  return {
    id: m.id,
    type: m.referencedMessageId ? 19 : 0,
    authorId: m.authorId,
    authorName: profile?.displayName ?? m.authorId,
    authorBot: profile?.bot ?? false,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
    content: m.content,
    referencedMessageId: m.referencedMessageId,
    embeds: [...card, ...m.embeds.map((e) => structuredClone(e))],
    attachments: m.attachments.map((a) => ({ id: a.id, filename: a.filename, size: a.size, contentType: a.contentType })),
  };
}

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
