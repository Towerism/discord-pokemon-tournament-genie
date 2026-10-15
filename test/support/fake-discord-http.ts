import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Overwrite } from '../../shared/discord/overwrites';
import type { FakeDiscord } from '../../server/modules/discord/fake';
import { type ChannelState, type HistoryMessage, type OutboundMessage, DiscordPermissionError, DiscordUnavailableError } from '../../server/modules/discord/port';
import { PERMISSION_BITS } from '../../shared/discord/permissions';

export interface FakeDiscordHttp {
  url: string;
  /** The Discord user the next OAuth consent logs in as. */
  loginAs(userId: string): void;
  /** The token exchange answers 400 `invalid_grant` while true. */
  failTokenExchange: boolean;
  /** Every request path, for asserting what Genie asked for. */
  requests: string[];
  close(): Promise<void>;
}

/**
 * Discord's REST API and OAuth endpoints over HTTP, backed by the in-memory fake, for the built app. The gateway
 * is refused (`GET /gateway/bot` answers 503), so the bot in a built app stays in `error`.
 */
export async function startFakeDiscordHttp(fake: FakeDiscord): Promise<FakeDiscordHttp> {
  let nextUser: string | null = null;
  const codes = new Map<string, { userId: string; clientId: string; redirectUri: string }>();
  const accessTokens = new Map<string, string>();
  let counter = 0;

  const state: FakeDiscordHttp = {
    url: '',
    loginAs: (userId) => {
      nextUser = userId;
    },
    failTokenExchange: false,
    requests: [],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => send(res, 500, { message: String(err) }));
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = decodeURIComponent(url.pathname).replace(/^\/api\/v10\//, '/api/');
    state.requests.push(`${req.method} ${path}`);
    const auth = req.headers.authorization ?? '';

    // Discord's CDN: the fake's attachments while their URLs are valid.
    if (req.method === 'GET' && path.startsWith('/attachments/')) {
      const answer = fake.cdnServe(`${state.url}${req.url ?? ''}`);
      if (answer.status === 302) return void res.writeHead(302, { location: answer.location }).end();
      if (answer.status !== 200 || !answer.body) return void res.writeHead(answer.status).end();
      return void res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(answer.body);
    }

    // Test control (Playwright runs in another process than the fake): a member posts, as Discord would allow.
    if (req.method === 'POST' && path === '/_test/post') {
      const { userId, channelId, content } = JSON.parse(await body(req)) as { userId: string; channelId: string; content: string };
      try {
        return send(res, 200, { id: fake.post(userId, channelId, { content }) });
      } catch {
        return send(res, 403, { message: 'Missing Permissions', code: 50013 });
      }
    }
    if (req.method === 'POST' && path === '/_test/login-as') {
      nextUser = (JSON.parse(await body(req)) as { userId: string }).userId;
      return send(res, 204, null);
    }

    // OAuth consent: the page a browser sees at Discord.
    if (req.method === 'GET' && path === '/oauth2/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      if (!nextUser) return send(res, 400, { message: 'loginAs() was not called' });
      const code = `fake-code-${++counter}`;
      codes.set(code, { userId: nextUser, clientId: url.searchParams.get('client_id') ?? '', redirectUri });
      const target = new URL(redirectUri);
      target.searchParams.set('code', code);
      target.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Discord</title><h1>Authorize Genie</h1><a id="authorize" href="${escape(target.toString())}">Authorize</a>`);
      return;
    }
    if (req.method === 'POST' && path === '/api/oauth2/token') {
      const form = new URLSearchParams(await body(req));
      const grant = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      const app = fake.applications.get(form.get('client_id') ?? '');
      if (state.failTokenExchange || !grant || grant.redirectUri !== form.get('redirect_uri')) {
        return send(res, 400, { error: 'invalid_grant' });
      }
      if (!app || form.get('client_secret') !== app.clientSecret) return send(res, 401, { error: 'invalid_client' });
      const token = `fake-access-${++counter}`;
      accessTokens.set(token, grant.userId);
      return send(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 604800, scope: 'identify' });
    }
    if (req.method === 'GET' && path === '/api/users/@me' && auth.startsWith('Bearer ')) {
      const userId = accessTokens.get(auth.slice('Bearer '.length));
      if (!userId) return send(res, 401, { message: '401: Unauthorized', code: 0 });
      return send(res, 200, { id: userId, username: `user${userId.slice(-4)}`, global_name: `User ${userId.slice(-4)}`, avatar: null });
    }

    // The bot's REST API.
    if (fake.unavailable) return send(res, 503, { message: 'Service unavailable' });
    const appId = fake.tokens.get(auth.replace(/^Bot /, ''));
    const app = appId ? fake.applications.get(appId) : undefined;
    if (!app) return send(res, 401, { message: '401: Unauthorized', code: 0 });

    if (req.method === 'GET' && path === '/api/gateway/bot') return send(res, 503, { message: 'The fake has no gateway' });
    if (req.method === 'GET' && path === '/api/applications/@me') {
      return send(res, 200, { id: app.id, bot_public: app.botPublic, flags: app.flags, name: 'Genie' });
    }
    if (req.method === 'GET' && path === '/api/users/@me') return send(res, 200, { id: app.botUserId, username: 'Genie', bot: true });
    if (req.method === 'GET' && path === '/api/users/@me/guilds') {
      const guilds = [...fake.guilds.values()].filter((g) => g.members.has(app.botUserId));
      return send(res, 200, guilds.map((g) => ({ id: g.id, name: g.name })));
    }
    let m = /^\/api\/guilds\/(\d+)$/.exec(path);
    if (req.method === 'GET' && m) {
      const guild = fake.guilds.get(m[1]!);
      if (!guild) return send(res, 404, { message: 'Unknown Guild', code: 10004 });
      if (!guild.members.has(app.botUserId)) return send(res, 403, { message: 'Missing Access', code: 50001 });
      return send(res, 200, {
        id: guild.id,
        name: guild.name,
        owner_id: guild.ownerId,
        roles: guild.roles.map((r) => ({ ...r, permissions: r.permissions.toString() })),
      });
    }

    // Members, channels and messages go through the in-memory fake's own port, so its rules (S3's write
    // refusals, failure injection) hold over HTTP too.
    const gateway = fake.create(auth.replace(/^Bot /, '')).gateway;
    const guildOf = (id: string) => {
      const guild = fake.guilds.get(id);
      return guild?.members.has(app.botUserId) ? guild : null;
    };
    const apiMember = (guild: NonNullable<ReturnType<typeof guildOf>>, userId: string) => {
      const profile = guild.profiles.get(userId);
      const username = profile?.username ?? `user${userId.slice(-4)}`;
      return {
        user: { id: userId, username, global_name: null, bot: profile?.bot ?? false },
        nick: profile && profile.displayName !== username ? profile.displayName : null,
        roles: guild.members.get(userId) ?? [],
      };
    };
    m = /^\/api\/guilds\/(\d+)\/members\/search$/.exec(path);
    if (req.method === 'GET' && m) {
      const guild = guildOf(m[1]!);
      if (!guild) return send(res, 403, { message: 'Missing Access', code: 50001 });
      const found = await gateway.searchMembers(guild.id, url.searchParams.get('query') ?? '', Number(url.searchParams.get('limit') ?? 25));
      return send(res, 200, found.map((f) => apiMember(guild, f.userId)));
    }
    m = /^\/api\/guilds\/(\d+)\/members$/.exec(path);
    if (req.method === 'GET' && m) {
      const guild = guildOf(m[1]!);
      if (!guild) return send(res, 403, { message: 'Missing Access', code: 50001 });
      const after = BigInt(url.searchParams.get('after') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? 1);
      const ids = [...guild.members.keys()].filter((id) => BigInt(id) > after).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).slice(0, limit);
      return send(res, 200, ids.map((id) => apiMember(guild, id)));
    }
    m = /^\/api\/guilds\/(\d+)\/members\/(\d+)$/.exec(path);
    if (req.method === 'GET' && m) {
      const guild = fake.guilds.get(m[1]!);
      if (!guild?.members.has(app.botUserId)) return send(res, 403, { message: 'Missing Access', code: 50001 });
      const roles = guild.members.get(m[2]!);
      if (!roles) return send(res, 404, { message: 'Unknown Member', code: 10007 });
      return send(res, 200, apiMember(guild, m[2]!));
    }
    m = /^\/api\/guilds\/(\d+)\/channels$/.exec(path);
    if (m) {
      const guild = guildOf(m[1]!);
      if (!guild) return send(res, 403, { message: 'Missing Access', code: 50001 });
      if (req.method === 'GET') return send(res, 200, (await gateway.listChannels(guild.id)).map((c) => apiChannel(guild.id, c)));
      if (req.method === 'POST') {
        const spec = JSON.parse(await body(req)) as ApiChannelBody;
        const overwrites = spec.permission_overwrites?.map((o) => genieOverwrite(guild.id, o));
        return answer(res, async () => {
          const id =
            spec.type === 4
              ? await gateway.createCategory(guild.id, { name: spec.name!, overwrites: overwrites ?? [] })
              : await gateway.createChannel(guild.id, {
                  name: spec.name!,
                  parentId: spec.parent_id!,
                  ...(spec.topic === undefined ? {} : { topic: spec.topic }),
                  ...(spec.position === undefined ? {} : { position: spec.position }),
                  ...(overwrites === undefined ? {} : { overwrites }),
                });
          return apiChannel(guild.id, (await gateway.getChannel(id))!);
        });
      }
    }
    m = /^\/api\/channels\/(\d+)$/.exec(path);
    if (m) {
      const id = m[1]!;
      const existing = fake.channels.get(id);
      if (!existing) return send(res, 404, { message: 'Unknown Channel', code: 10003 });
      if (req.method === 'GET') return send(res, 200, apiChannel(existing.guildId, (await gateway.getChannel(id))!));
      if (req.method === 'DELETE') return answer(res, async () => ({ deleted: await gateway.deleteChannel(id, 'http') }));
      if (req.method === 'PATCH') {
        const patch = JSON.parse(await body(req)) as ApiChannelBody;
        return answer(res, async () => {
          if (patch.permission_overwrites) await gateway.setOverwrites(id, patch.permission_overwrites.map((o) => genieOverwrite(existing.guildId, o)));
          const fields = {
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.topic === undefined ? {} : { topic: patch.topic }),
            ...(patch.parent_id === undefined || patch.parent_id === null ? {} : { parentId: patch.parent_id }),
            ...(patch.position === undefined ? {} : { position: patch.position }),
          };
          if (Object.keys(fields).length) await gateway.updateChannel(id, fields);
          return apiChannel(existing.guildId, (await gateway.getChannel(id))!);
        });
      }
    }
    m = /^\/api\/channels\/(\d+)\/messages$/.exec(path);
    if (req.method === 'POST' && m) {
      // Like Discord: a channel deleted by hand is 404 Unknown Channel, which discord.js doesn't retry.
      if (!fake.channels.has(m[1]!)) return send(res, 404, { message: 'Unknown Channel', code: 10003 });
      const msg = outbound(JSON.parse(await body(req)) as ApiMessageBody);
      return answer(res, async () => ({ id: await gateway.postMessage(m![1]!, msg) }));
    }
    m = /^\/api\/channels\/(\d+)\/messages\/(\d+)$/.exec(path);
    if (req.method === 'PATCH' && m) {
      const msg = outbound(JSON.parse(await body(req)) as ApiMessageBody);
      const edited = await gateway.editMessage(m[1]!, m[2]!, msg);
      if (edited === 'gone') return send(res, 404, { message: 'Unknown Message', code: 10008 });
      return send(res, 200, { id: m[2] });
    }
    if (req.method === 'DELETE' && m) {
      const deleted = await gateway.deleteMessage(m[1]!, m[2]!);
      if (deleted === 'already_gone') return send(res, 404, { message: 'Unknown Message', code: 10008 });
      return send(res, 204, null);
    }
    // Close-out reads: history (a thread's too), one message, and the thread listings.
    m = /^\/api\/channels\/(\d+)\/messages$/.exec(path);
    if (req.method === 'GET' && m) {
      const before = url.searchParams.get('before') ?? undefined;
      const limit = Number(url.searchParams.get('limit') ?? 50);
      try {
        const page = await gateway.readHistory(m[1]!, before);
        if (page === null) return send(res, 404, { message: 'Unknown Channel', code: 10003 });
        return send(res, 200, page.slice(0, limit).map(apiMessage));
      } catch (err) {
        if (err instanceof DiscordPermissionError) return send(res, 403, { message: 'Missing Access', code: 50001 });
        throw err;
      }
    }
    m = /^\/api\/channels\/(\d+)\/messages\/(\d+)$/.exec(path);
    if (req.method === 'GET' && m) {
      const message = fake.messages.get(m[2]!);
      if (!message || message.channelId !== m[1]) return send(res, 404, { message: 'Unknown Message', code: 10008 });
      const history = ((await gateway.readHistory(m[1]!)) ?? []).find((h) => h.id === m![2]);
      const page = history ? [history] : [];
      const attachments = [];
      for (const a of message.attachments) {
        const resolved = await gateway.resolveAttachment(m[1]!, m[2]!, a.id);
        if ('url' in resolved) attachments.push({ id: a.id, filename: a.filename, size: a.size, content_type: a.contentType, url: resolved.url });
      }
      return send(res, 200, { ...apiMessage(page[0] ?? fallbackHistory(message)), attachments });
    }
    m = /^\/api\/guilds\/(\d+)\/threads\/active$/.exec(path);
    if (req.method === 'GET' && m) {
      const guildId = m[1]!;
      const threads = [...fake.threads.values()].filter((t) => {
        const parent = fake.channels.get(t.channelId);
        if (!parent || parent.guildId !== guildId || t.archived) return false;
        // Without Manage Threads, Discord leaves out private threads the bot isn't in (spike S4).
        const manages = (fake.permissionsFor(app.botUserId, t.channelId) & PERMISSION_BITS.ManageThreads) !== 0n;
        return t.type === 'public' || manages || t.memberIds.includes(app.botUserId);
      });
      return send(res, 200, { threads: threads.map(apiThread), members: [] });
    }
    m = /^\/api\/channels\/(\d+)\/threads\/archived\/(public|private)$/.exec(path);
    if (req.method === 'GET' && m) {
      const channelId = m[1]!;
      if (!fake.channels.has(channelId)) return send(res, 404, { message: 'Unknown Channel', code: 10003 });
      const manages = (fake.permissionsFor(app.botUserId, channelId) & PERMISSION_BITS.ManageThreads) !== 0n;
      if (m[2] === 'private' && !manages) return send(res, 403, { message: 'Missing Access', code: 50001 });
      const threads = [...fake.threads.values()].filter((t) => t.channelId === channelId && t.archived && t.type === m![2]);
      return send(res, 200, { threads: threads.map(apiThread), members: [], has_more: false });
    }
    m = /^\/api\/channels\/(\d+)\/pins\/(\d+)$/.exec(path);
    if (req.method === 'PUT' && m) {
      await gateway.pinMessage(m[1]!, m[2]!);
      return send(res, 204, null);
    }
    m = /^\/api\/applications\/(\d+)\/guilds\/(\d+)\/commands$/.exec(path);
    if (req.method === 'PUT' && m) {
      fake.commands.set(m[2]!, JSON.parse(await body(req)));
      return send(res, 200, []);
    }
    return send(res, 404, { message: `No fake for ${req.method} ${path}`, code: 0 });
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.cdnBase = state.url;
  return state;
}

function apiMessage(m: HistoryMessage) {
  return {
    id: m.id,
    type: m.type,
    author: { id: m.authorId, username: m.authorName, global_name: m.authorName, bot: m.authorBot },
    timestamp: new Date(m.createdAt).toISOString(),
    edited_timestamp: m.editedAt === null ? null : new Date(m.editedAt).toISOString(),
    content: m.content,
    ...(m.referencedMessageId ? { message_reference: { message_id: m.referencedMessageId } } : {}),
    embeds: m.embeds.map((e) => ({ ...(e.title === null ? {} : { title: e.title }), ...(e.description === null ? {} : { description: e.description }), ...(e.url === null ? {} : { url: e.url }), fields: e.fields })),
    attachments: m.attachments.map((a) => ({ id: a.id, filename: a.filename, size: a.size, content_type: a.contentType, url: 'https://cdn.invalid/' })),
  };
}

function fallbackHistory(m: { id: string; authorId: string; content: string; createdAt: number }): HistoryMessage {
  return { id: m.id, type: 0, authorId: m.authorId, authorName: m.authorId, authorBot: false, createdAt: m.createdAt, editedAt: null, content: m.content, referencedMessageId: null, embeds: [], attachments: [] };
}

function apiThread(t: { id: string; channelId: string; name: string; type: 'public' | 'private'; archived: boolean }) {
  return {
    id: t.id,
    type: t.type === 'private' ? 12 : 11,
    parent_id: t.channelId,
    name: t.name,
    thread_metadata: { archived: t.archived, archive_timestamp: new Date(0).toISOString(), auto_archive_duration: 1440, locked: false },
  };
}

interface ApiMessageBody {
  content: string;
  embeds?: { title: string; fields?: { name: string; value: string }[]; footer?: { text: string } }[];
  components?: { components: { custom_id: string; label: string; style: number }[] }[];
}

/** A Discord message body back into the port's terms (style 4 is Danger). */
function outbound(msg: ApiMessageBody): OutboundMessage {
  const buttons = (msg.components ?? []).flatMap((row) => row.components.map((b) => ({ customId: b.custom_id, label: b.label, ...(b.style === 4 ? { style: 'danger' as const } : {}) })));
  const embed = msg.embeds?.[0];
  return {
    content: msg.content,
    ...(embed ? { embed: { title: embed.title, fields: embed.fields ?? [], ...(embed.footer ? { footer: embed.footer.text } : {}) } } : {}),
    ...(buttons.length ? { buttons } : {}),
  };
}

interface ApiOverwrite {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
}
interface ApiChannelBody {
  name?: string;
  type?: number;
  parent_id?: string | null;
  topic?: string | null;
  position?: number;
  permission_overwrites?: ApiOverwrite[];
}

function genieOverwrite(guildId: string, o: ApiOverwrite): Overwrite {
  const target: Overwrite['target'] = o.type === 1 ? { kind: 'member', id: o.id } : o.id === guildId ? { kind: 'everyone' } : { kind: 'role', id: o.id };
  return { target, allow: BigInt(o.allow), deny: BigInt(o.deny) };
}

function apiChannel(guildId: string, c: ChannelState) {
  return {
    id: c.id,
    guild_id: guildId,
    type: c.type === 'category' ? 4 : 0,
    name: c.name,
    parent_id: c.parentId,
    topic: c.topic,
    position: c.position,
    permission_overwrites: c.overwrites.map((o) => ({
      id: o.target.kind === 'everyone' ? guildId : o.target.id,
      type: o.target.kind === 'member' ? 1 : 0,
      allow: o.allow.toString(),
      deny: o.deny.toString(),
    })),
  };
}

/** Runs a port call and answers as Discord would: a refusal is 403 / 50013, an outage 503. */
async function answer(res: ServerResponse, fn: () => Promise<unknown>) {
  try {
    return send(res, 200, await fn());
  } catch (err) {
    if (err instanceof DiscordPermissionError) return send(res, 403, { message: 'Missing Permissions', code: 50013 });
    if (err instanceof DiscordUnavailableError) return send(res, 503, { message: err.message });
    throw err;
  }
}

function send(res: ServerResponse, status: number, json: unknown) {
  // Like Discord, a 204 has no body and no content type (discord.js would parse one).
  res.writeHead(status, status === 204 ? {} : { 'content-type': 'application/json' });
  res.end(status === 204 ? undefined : JSON.stringify(json));
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
