import { randomBytes } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { OUT_DIR, log, warn } from '../../io/session.js';
import type { Config } from '../../shared/config.js';
import { authorizeUrl, classifySetup, handleCallback, stateCookie, type CookieMode, type S1Attempt, type S1Outcome } from '../oauth.js';

const ATTEMPTS = join(OUT_DIR, 's1-attempts.jsonl');

const append = (a: S1Attempt) => appendFile(ATTEMPTS, `${JSON.stringify(a)}\n`);

/** Two routes. Binds to 127.0.0.1 unless --host is given. */
export async function s1Serve(c: Config, opts: { redirect: string; host: string; port: number; cookieMode: CookieMode }) {
  const redirectPath = new URL(opts.redirect).pathname;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        const state = randomBytes(32).toString('hex');
        res.writeHead(302, {
          location: authorizeUrl({ clientId: c.GENIE_SPIKE_GENIE_CLIENT_ID!, redirectUri: opts.redirect, state }),
          'set-cookie': stateCookie(state, opts.cookieMode),
        });
        res.end();
        return;
      }
      if (req.method === 'GET' && url.pathname === redirectPath) {
        const result = await handleCallback(
          { code: url.searchParams.get('code') ?? undefined, state: url.searchParams.get('state') ?? undefined },
          req.headers.cookie,
          {
            clientId: c.GENIE_SPIKE_GENIE_CLIENT_ID!,
            clientSecret: c.GENIE_SPIKE_GENIE_CLIENT_SECRET!,
            redirectUri: opts.redirect,
            cookieMode: opts.cookieMode,
            now: () => new Date(),
            fetch,
          },
        );
        await append(result.attempt);
        log(`attempt: ${result.attempt.setup} ${result.attempt.cookieMode} → ${result.attempt.outcome}`);
        res.writeHead(result.status, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' });
        res.end(result.html);
        return;
      }
      res.writeHead(404).end();
    } catch (e) {
      warn(`request failed: ${(e as Error).message}`); // redacted: never echoes code or state
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve));
  log(`S1 listening on http://${opts.host}:${opts.port}/ (redirect ${opts.redirect}, ${opts.cookieMode} cookie). Ctrl-C to stop.`);
  await new Promise<void>((resolve) => process.once('SIGINT', () => {
      server.close(() => resolve());
      server.closeAllConnections(); // a browser's keep-alive socket would otherwise hold the close open
    }));
}

/** Outcomes Discord shows on its own pages (portal or authorize rejection). */
export async function s1Note(opts: { redirect: string; outcome: S1Outcome; cookieMode: CookieMode; detail?: string }) {
  const a: S1Attempt = {
    at: new Date().toISOString(),
    redirectUri: opts.redirect,
    setup: classifySetup(opts.redirect),
    cookieMode: opts.cookieMode,
    outcome: opts.outcome,
    ...(opts.detail ? { discordError: opts.detail } : {}),
  };
  await append(a);
  log(`noted: ${a.setup} → ${a.outcome}`);
}
