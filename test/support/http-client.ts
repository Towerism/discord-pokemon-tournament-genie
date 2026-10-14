import { request } from 'node:http';

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json<T = unknown>(): T;
  setCookies: string[];
  location: string | undefined;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
  body?: string;
}

/**
 * A browser-ish client for the built app: keeps cookies (by name), never follows redirects, and can send the
 * `Host` and `X-Forwarded-*` headers that fetch forbids.
 */
export function browser(base: string, defaults: { host?: string; headers?: Record<string, string> } = {}) {
  const jar = new Map<string, string>();
  const replies: Reply[] = [];

  function send(path: string, opts: RequestOptions = {}): Promise<Reply> {
    const url = new URL(path, base);
    const headers: Record<string, string> = { ...defaults.headers, ...opts.headers };
    headers.host ??= defaults.host ?? `localhost:${url.port}`;
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body = opts.body;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers['content-type'] ??= 'application/json';
    }
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
    return new Promise((resolve, reject) => {
      const req = request(url, { method: opts.method ?? 'GET', headers }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          const setCookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
          for (const cookie of setCookies) {
            const [pair] = cookie.split(';');
            const [name, ...value] = pair!.split('=');
            const v = value.join('=');
            if (v === '' || /max-age=0/i.test(cookie) || /expires=Thu, 01 Jan 1970/i.test(cookie)) jar.delete(name!.trim());
            else jar.set(name!.trim(), v);
          }
          const reply: Reply = {
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json: <T>() => JSON.parse(text) as T,
            setCookies,
            location: res.headers.location,
          };
          replies.push(reply);
          resolve(reply);
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  return {
    get: (path: string, opts?: RequestOptions) => send(path, { ...opts, method: 'GET' }),
    post: (path: string, json?: unknown, opts?: RequestOptions) => send(path, { ...opts, method: 'POST', json: json ?? {} }),
    put: (path: string, json?: unknown, opts?: RequestOptions) => send(path, { ...opts, method: 'PUT', json: json ?? {} }),
    send,
    cookies: jar,
    /** Every reply this browser received, for secret scanning. */
    replies,
  };
}

export type Browser = ReturnType<typeof browser>;
