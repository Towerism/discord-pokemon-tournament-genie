import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Overwrite } from '../../shared/discord/overwrites';
import type { FakeDiscord } from '../../server/modules/discord/fake';
import { type ChannelState, DiscordPermissionError, DiscordUnavailableError } from '../../server/modules/discord/port';

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

    // Test control (Playwright runs in another process than the fake).
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
      const msg = JSON.parse(await body(req)) as { content: string; components?: { components: { custom_id: string; label: string }[] }[] };
      const buttons = (msg.components ?? []).flatMap((row) => row.components.map((b) => ({ customId: b.custom_id, label: b.label })));
      return answer(res, async () => ({ id: await gateway.postMessage(m![1]!, { content: msg.content, ...(buttons.length ? { buttons } : {}) }) }));
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
  return state;
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
