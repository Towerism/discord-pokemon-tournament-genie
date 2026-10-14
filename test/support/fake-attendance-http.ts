import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { AttendanceDay } from '../../server/modules/attendance/port';

/** A one-shot misbehaviour for the next day read. */
export type AttendanceHttpMode =
  | { kind: 'rate_limited'; retryAfter?: string }
  | { kind: 'league_not_selected' }
  | { kind: 'server_error' }
  | { kind: 'professor_unidentified' }
  | { kind: 'redirect' }
  | { kind: 'oversize'; bytes: number }
  | { kind: 'malformed' }
  | { kind: 'hang' };

export interface FakeAttendanceHttp {
  url: string;
  /** The token attendance accepts. */
  token: string;
  /** Days by date, in Genie's port shape; served as v1's wire shape (`toWire`). */
  readonly days: Map<string, AttendanceDay>;
  /** A raw body served for a date instead of `days` (the recorded fixture, or a malformed answer). */
  readonly raw: Map<string, unknown>;
  /** Every request: its path, and whether it carried any `Authorization` and the right token. */
  readonly requests: { path: string; authorization: boolean; tokenMatched: boolean }[];
  /** The next day reads misbehave this way, one per entry. */
  next(...modes: AttendanceHttpMode[]): void;
  close(): Promise<void>;
}

const DAY_PATH = /^\/api\/integrations\/v1\/days\/([^/]+)$/;

/**
 * Attendance's `GET /api/integrations/v1/days/{date}` over HTTP (attendance #115), for the adapter's tests, the contract
 * suite and the built app. Answers like attendance: 401 `invalid_token` for a wrong token, h3's error body with
 * `data.code`. `POST /_test/*` lets another process (Playwright) set the state.
 */
export async function startFakeAttendanceHttp(opts: { token: string }): Promise<FakeAttendanceHttp> {
  const modes: AttendanceHttpMode[] = [];
  const sockets = new Set<Socket>();
  const state: FakeAttendanceHttp = {
    url: '',
    token: opts.token,
    days: new Map(),
    raw: new Map(),
    requests: [],
    next: (...next) => {
      modes.push(...next);
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => send(res, 500, { message: String(err) }));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://fake').pathname;
    const auth = req.headers.authorization ?? '';
    state.requests.push({ path, authorization: auth !== '', tokenMatched: auth === `Bearer ${state.token}` });

    if (req.method === 'POST' && path === '/_test/day') {
      const { date, raw } = JSON.parse(await body(req)) as { date: string; raw: unknown };
      state.raw.set(date, raw);
      return send(res, 204, null);
    }
    if (req.method === 'POST' && path === '/_test/token') {
      state.token = (JSON.parse(await body(req)) as { token: string }).token;
      return send(res, 204, null);
    }
    if (path === '/elsewhere') return send(res, 200, { moved: true });

    const match = DAY_PATH.exec(path);
    if (req.method !== 'GET' || !match) return send(res, 404, { statusCode: 404, message: 'Not found', data: { code: 'not_found' } });
    if (auth !== `Bearer ${state.token}`) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="integrations", error="invalid_token"');
      return send(res, 401, { statusCode: 401, message: 'A valid integration token is required.', data: { code: 'invalid_token' } });
    }

    const mode = modes.shift();
    switch (mode?.kind) {
      case 'rate_limited':
        if (mode.retryAfter !== undefined) res.setHeader('Retry-After', mode.retryAfter);
        return send(res, 429, { statusCode: 429, message: 'Too many requests.', data: { code: 'rate_limited' } });
      case 'league_not_selected':
        return send(res, 409, { statusCode: 409, message: 'Select a league first.', data: { code: 'league_not_selected' } });
      case 'server_error':
        return send(res, 500, { statusCode: 500, message: 'Internal Server Error' });
      case 'professor_unidentified':
        return send(res, 503, { statusCode: 503, message: 'Reconnect them in Settings.', data: { code: 'professor_unidentified' } });
      case 'redirect':
        res.writeHead(302, { location: `${state.url}/elsewhere` });
        return res.end();
      case 'oversize':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(`"${'x'.repeat(mode.bytes)}"`);
      case 'malformed':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"date": ');
      case 'hang':
        return; // never answers; close() destroys the socket
      case undefined:
        break;
    }

    const date = decodeURIComponent(match[1]!);
    if (state.raw.has(date)) return send(res, 200, state.raw.get(date));
    const day = state.days.get(date) ?? { date, timeZone: 'America/Chicago', tournaments: [], professors: [] };
    return send(res, 200, toWire(day));
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

/** Genie's port shape as attendance sends it (v1: `timezone`, ISO `startsAt`). */
export function toWire(day: AttendanceDay): unknown {
  return {
    date: day.date,
    timezone: day.timeZone,
    tournaments: day.tournaments.map((t) => ({
      id: t.id,
      name: t.name,
      displayId: t.displayId,
      startsAt: new Date(t.startsAt).toISOString(),
      game: t.game,
      organizer: t.organizer,
      staff: t.staff,
    })),
    professors: day.professors,
  };
}

function send(res: ServerResponse, status: number, json: unknown) {
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
