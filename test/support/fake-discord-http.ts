import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FakeDiscord } from '../../server/modules/discord/fake';

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
        roles: guild.roles.map((r) => ({ ...r, permissions: r.permissions.toString() })),
      });
    }
    m = /^\/api\/guilds\/(\d+)\/members\/(\d+)$/.exec(path);
    if (req.method === 'GET' && m) {
      const guild = fake.guilds.get(m[1]!);
      if (!guild?.members.has(app.botUserId)) return send(res, 403, { message: 'Missing Access', code: 50001 });
      const roles = guild.members.get(m[2]!);
      if (!roles) return send(res, 404, { message: 'Unknown Member', code: 10007 });
      return send(res, 200, { user: { id: m[2] }, roles });
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

function send(res: ServerResponse, status: number, json: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(json));
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
