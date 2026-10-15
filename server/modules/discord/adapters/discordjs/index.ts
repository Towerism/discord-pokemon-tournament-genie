/**
 * The `DiscordGateway` port over discord.js (ADR-0003). The only file that imports discord.js; its payload
 * shapes stop here. Covered by the built-app tests against an HTTP fake of Discord, and by the manual smoke on
 * the test guild (Discord has no sandbox).
 */
import type { Logger } from '@towerism/selfhost-kit';
import {
  type APIApplication,
  type APIChannel,
  type APIGuild,
  type APIGuildChannel,
  type APIGuildMember,
  type APIOverwrite,
  type APIUser,
  type Interaction,
  ApplicationCommandOptionType,
  ButtonStyle,
  ChannelType,
  Client,
  ComponentType,
  DiscordAPIError,
  DiscordjsError,
  DiscordjsErrorCodes,
  Events,
  GatewayCloseCodes,
  GatewayIntentBits,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  OverwriteType,
  REST,
  Routes,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { Member } from '../../../../../shared/access/access';
import {
  type ChannelState,
  type CreateDiscord,
  type DiscordBotConnection,
  type DiscordGateway,
  type GuildInfo,
  type GuildMember,
  type InboundInteraction,
  type InteractionReply,
  type ModalSpec,
  type OutboundMessage,
  type Overwrite,
  DisallowedIntentsError,
  DiscordAuthError,
  DiscordPermissionError,
  DiscordRequestError,
  DiscordUnavailableError,
} from '../../port';

const READY_TIMEOUT_MS = 30_000;
/** Discord JSON error codes that mean "not there" or "can't see it". */
const UNKNOWN_GUILD = 10004;
const UNKNOWN_MEMBER = 10007;
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;
const MEMBER_PAGE = 1000;

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
        const channels = await call<unknown[]>(() => rest.get(Routes.guildChannels(guildId)));
        return guildInfo(guild, self.roles, bot, channels.length);
      },
      async getMember(guildId, userId): Promise<Member | null> {
        const member = await orNull<APIGuildMember>(() => rest.get(Routes.guildMember(guildId, userId)), [UNKNOWN_MEMBER]);
        return member ? { userId, roleIds: [...member.roles] } : null;
      },
      async listMembers(guildId) {
        const all: GuildMember[] = [];
        let after = '0';
        for (;;) {
          const page = await call<APIGuildMember[]>(() =>
            rest.get(Routes.guildMembers(guildId), { query: new URLSearchParams({ limit: String(MEMBER_PAGE), after }) }),
          );
          for (const m of page) if (m.user) all.push(guildMember(m));
          if (page.length < MEMBER_PAGE) return all;
          after = page.at(-1)!.user!.id;
        }
      },
      async searchMembers(guildId, query, limit) {
        const found = await call<APIGuildMember[]>(() =>
          rest.get(Routes.guildMembersSearch(guildId), { query: new URLSearchParams({ query, limit: String(limit) }) }),
        );
        return found.filter((m) => m.user).map(guildMember);
      },
      async createCategory(guildId, spec) {
        const created = await call<APIChannel>(() =>
          rest.post(Routes.guildChannels(guildId), {
            body: { name: spec.name, type: ChannelType.GuildCategory, permission_overwrites: spec.overwrites.map((o) => apiOverwrite(guildId, o)) },
            reason: 'Tournament Genie: create the day category',
          }),
        );
        return created.id;
      },
      async createChannel(guildId, spec) {
        const body: Record<string, unknown> = { name: spec.name, type: ChannelType.GuildText, parent_id: spec.parentId };
        if (spec.topic !== undefined && spec.topic !== null) body.topic = spec.topic;
        if (spec.position !== undefined) body.position = spec.position;
        // Omitted, Discord copies the category's overwrites; Genie always sends them.
        if (spec.overwrites !== undefined) body.permission_overwrites = spec.overwrites.map((o) => apiOverwrite(guildId, o));
        const created = await call<APIChannel>(() => rest.post(Routes.guildChannels(guildId), { body, reason: 'Tournament Genie: create a day channel' }));
        return created.id;
      },
      async updateChannel(channelId, patch) {
        // No lock_permissions: a move never syncs the channel to its new category's overwrites.
        const body: Record<string, unknown> = {};
        if (patch.name !== undefined) body.name = patch.name;
        if (patch.topic !== undefined) body.topic = patch.topic;
        if (patch.parentId !== undefined) body.parent_id = patch.parentId;
        if (patch.position !== undefined) body.position = patch.position;
        await call(() => rest.patch(Routes.channel(channelId), { body, reason: 'Tournament Genie: correct a day channel' }));
      },
      async setOverwrites(channelId, overwrites) {
        const current = await call<APIGuildChannel>(() => rest.get(Routes.channel(channelId)));
        await call(() =>
          rest.patch(Routes.channel(channelId), {
            body: { permission_overwrites: overwrites.map((o) => apiOverwrite(current.guild_id ?? '', o)) },
            reason: 'Tournament Genie: apply the day plan',
          }),
        );
      },
      async getChannel(channelId) {
        const channel = await orNull<APIGuildChannel>(() => rest.get(Routes.channel(channelId)), [UNKNOWN_CHANNEL]);
        return channel ? channelState(channel) : null;
      },
      async listChannels(guildId) {
        const list = await call<APIGuildChannel[]>(() => rest.get(Routes.guildChannels(guildId)));
        return list.map(channelState);
      },
      async deleteChannel(channelId, reason) {
        const gone = await orNull(() => rest.delete(Routes.channel(channelId), { reason: `Tournament Genie: ${reason}` }), [UNKNOWN_CHANNEL]);
        return gone === null ? 'already_gone' : 'deleted';
      },
      async postMessage(channelId, msg) {
        const sent = await call<{ id: string }>(() => rest.post(Routes.channelMessages(channelId), { body: messageBody(msg), reason: 'Tournament Genie: post a message' }));
        return sent.id;
      },
      async editMessage(channelId, messageId, msg) {
        const edited = await orNull(() => rest.patch(Routes.channelMessage(channelId, messageId), { body: messageBody(msg) }), [UNKNOWN_MESSAGE, UNKNOWN_CHANNEL]);
        return edited === null ? 'gone' : 'edited';
      },
      async deleteMessage(channelId, messageId) {
        const gone = await orNull(() => rest.delete(Routes.channelMessage(channelId, messageId)), [UNKNOWN_MESSAGE, UNKNOWN_CHANNEL]);
        return gone === null ? 'already_gone' : 'deleted';
      },
      async pinMessage(channelId, messageId) {
        await call(() => rest.put(Routes.channelPin(channelId, messageId), { reason: 'Tournament Genie: pin the day intro' }));
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
        const body = commands.map((c) => ({
          name: c.name,
          description: c.description,
          options: (c.options ?? []).map((o) => ({
            name: o.name,
            description: o.description,
            required: o.required,
            type: o.type === 'integer' ? ApplicationCommandOptionType.Integer : ApplicationCommandOptionType.String,
            ...(o.minValue === undefined ? {} : { min_value: o.minValue }),
            ...(o.maxValue === undefined ? {} : { max_value: o.maxValue }),
            ...(o.autocomplete ? { autocomplete: true } : {}),
          })),
        }));
        await call(() => rest.put(Routes.applicationGuildCommands(appId, guildId), { body }));
      },
    };

    return { gateway, bot };
  };
}

function apiOverwrite(guildId: string, o: Overwrite): APIOverwrite {
  const id = o.target.kind === 'everyone' ? guildId : o.target.id;
  const type = o.target.kind === 'member' ? OverwriteType.Member : OverwriteType.Role;
  return { id, type, allow: o.allow.toString(), deny: o.deny.toString() };
}

function genieOverwrite(guildId: string, o: APIOverwrite): Overwrite {
  const target: Overwrite['target'] =
    o.type === OverwriteType.Member ? { kind: 'member', id: o.id } : o.id === guildId ? { kind: 'everyone' } : { kind: 'role', id: o.id };
  return { target, allow: BigInt(o.allow), deny: BigInt(o.deny) };
}

function channelState(channel: APIGuildChannel): ChannelState {
  const guildId = channel.guild_id ?? '';
  const type = channel.type === ChannelType.GuildCategory ? 'category' : channel.type === ChannelType.GuildText ? 'text' : 'other';
  return {
    id: channel.id,
    type,
    name: channel.name ?? '',
    parentId: channel.parent_id ?? null,
    topic: 'topic' in channel && typeof channel.topic === 'string' ? channel.topic : null,
    position: 'position' in channel && typeof channel.position === 'number' ? channel.position : 0,
    overwrites: (channel.permission_overwrites ?? []).map((o) => genieOverwrite(guildId, o)),
  };
}

function guildMember(m: APIGuildMember): GuildMember {
  const user = m.user!;
  return {
    userId: user.id,
    roleIds: [...m.roles],
    displayName: m.nick ?? user.global_name ?? user.username,
    username: user.username,
    bot: user.bot ?? false,
  };
}

function guildInfo(guild: APIGuild, botRoleIds: readonly string[], botUserId: string, channelCount: number): GuildInfo {
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
    botUserId,
    ownerId: guild.owner_id,
    channelCount,
  };
}

/** A message body: never pings anyone (`allowed_mentions: none`), whatever its content or embed holds. */
function messageBody(msg: OutboundMessage): Record<string, unknown> {
  const body: Record<string, unknown> = { content: msg.content, allowed_mentions: { parse: [] }, embeds: [], components: [] };
  if (msg.embed) {
    body.embeds = [
      {
        title: msg.embed.title,
        fields: msg.embed.fields.map((f) => ({ name: f.name, value: f.value })),
        ...(msg.embed.footer ? { footer: { text: msg.embed.footer } } : {}),
      },
    ];
  }
  if (msg.buttons?.length) {
    body.components = [
      {
        type: ComponentType.ActionRow,
        components: msg.buttons.map((b) => ({ type: ComponentType.Button, style: b.style === 'danger' ? ButtonStyle.Danger : ButtonStyle.Primary, label: b.label, custom_id: b.customId })),
      },
    ];
  }
  return body;
}

/** The modal as spike S2 built it (ADR-0014): every component in a `Label`. */
function modalBuilder(spec: ModalSpec): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(spec.customId).setTitle(spec.title);
  for (const c of spec.components) {
    const label = new LabelBuilder().setLabel(c.label);
    if (c.kind === 'select') {
      label.setStringSelectMenuComponent(
        new StringSelectMenuBuilder().setCustomId(c.customId).addOptions(c.options.map((o) => ({ label: o.label, value: o.value, default: o.default ?? false }))),
      );
    } else {
      const input = new TextInputBuilder()
        .setCustomId(c.customId)
        .setStyle(c.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(c.required)
        .setMaxLength(c.maxLength);
      if (c.minLength > 0) input.setMinLength(c.minLength);
      if (c.value) input.setValue(c.value);
      label.setTextInputComponent(input);
    }
    modal.addLabelComponents(label);
  }
  return modal;
}

async function dispatch(interaction: Interaction, onInteraction: (i: InboundInteraction, reply: InteractionReply) => Promise<void>, logger: Logger) {
  let inbound: InboundInteraction;
  if (interaction.isChatInputCommand()) inbound = base(interaction, 'command', interaction.commandName);
  else if (interaction.isAutocomplete()) {
    const focused = interaction.options.getFocused(true);
    inbound = { ...base(interaction, 'autocomplete', interaction.commandName), focused: { name: focused.name, value: String(focused.value) } };
  } else if (interaction.isMessageComponent()) inbound = base(interaction, 'component', interaction.customId);
  else if (interaction.isModalSubmit()) {
    const fields: Record<string, string | string[]> = {};
    for (const [customId, data] of interaction.fields.fields) {
      if ('values' in data) fields[customId] = [...data.values];
      else if ('value' in data && typeof data.value === 'string') fields[customId] = data.value;
    }
    inbound = { ...base(interaction, 'modal', interaction.customId), fields };
  } else return;
  const reply: InteractionReply = {
    async ephemeral(text) {
      if (!interaction.isRepliable()) return;
      const body = { content: text, allowedMentions: { parse: [] } };
      if (interaction.deferred && !interaction.replied) await interaction.editReply(body);
      else if (interaction.replied) await interaction.followUp({ ...body, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ ...body, flags: MessageFlags.Ephemeral });
    },
    async deferEphemeral() {
      if (interaction.isRepliable() && !interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    },
    async showModal(spec) {
      if (interaction.isChatInputCommand() || interaction.isMessageComponent()) await interaction.showModal(modalBuilder(spec));
    },
    async autocomplete(choices) {
      if (interaction.isAutocomplete()) await interaction.respond(choices.slice(0, 25));
    },
  };
  try {
    await onInteraction(inbound, reply);
  } catch (err) {
    logger.error('An interaction handler escaped the router.', { interactionId: interaction.id, err });
  }
}

function base(interaction: Interaction, kind: InboundInteraction['kind'], name: string): InboundInteraction {
  const options: InboundInteraction['options'] = {};
  if (interaction.isChatInputCommand()) {
    for (const o of interaction.options.data) {
      if (typeof o.value === 'string' || typeof o.value === 'number' || typeof o.value === 'boolean') options[o.name] = o.value;
    }
  }
  const roles = interaction.member?.roles;
  const memberRoleIds = Array.isArray(roles) ? [...roles] : roles ? [...roles.cache.keys()] : [];
  const nick = interaction.member && 'nick' in interaction.member ? interaction.member.nick : null;
  return {
    id: interaction.id,
    kind,
    name,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    options,
    memberRoleIds: memberRoleIds.filter((id) => id !== interaction.guildId),
    userDisplayName: nick ?? interaction.user.globalName ?? interaction.user.username,
  };
}

function translate(err: unknown): Error {
  if (err instanceof DiscordAPIError && err.status === 401) return new DiscordAuthError('Discord refused the bot token.');
  if (err instanceof DiscordAPIError && err.code === MISSING_PERMISSIONS) return new DiscordPermissionError(`Discord refused the write: ${err.message}`);
  if (err instanceof DiscordjsError && err.code === DiscordjsErrorCodes.TokenInvalid) return new DiscordAuthError('Discord refused the bot token.');
  // A refusal is passed on without discord.js's error, whose `requestBody` holds what was sent (a card's notes).
  if (err instanceof DiscordAPIError && err.status < 500 && err.status !== 403) return new DiscordRequestError(err.status, err.code);
  // Any other refusal (403 Missing Access when the bot lost the guild, say) means Discord can't answer this for us.
  return new DiscordUnavailableError(`Discord could not be reached: ${err instanceof Error ? err.message : String(err)}`);
}
