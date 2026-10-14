import { DiscordAPIError, HTTPError, PermissionsBitField, REST, type RawFile } from 'discord.js';
import type { Outcome } from '../s3/types.js';

export type Route = `/${string}`;

/** A thin REST client per bot identity. 429s wait in discord.js's queue; 5xx are retried by it. */
export class Api {
  readonly rest: REST;
  constructor(token: string) {
    this.rest = new REST({ version: '10' }).setToken(token);
  }

  /** Never throws on an HTTP error: the outcome is data. */
  async call(
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    route: Route,
    options: { body?: unknown; query?: URLSearchParams; files?: RawFile[]; reason?: string } = {},
  ): Promise<Outcome> {
    try {
      const body = await this.rest[method](route, {
        ...(options.body !== undefined ? { body: options.body } : {}),
        ...(options.query ? { query: options.query } : {}),
        ...(options.files ? { files: options.files } : {}),
        ...(options.reason ? { reason: options.reason } : {}),
      });
      return { kind: 'http', status: 200, body }; // @discordjs/rest resolves only on 2xx
    } catch (e) {
      if (e instanceof DiscordAPIError) {
        return { kind: 'http', status: e.status, ...(typeof e.code === 'number' ? { code: e.code } : {}), body: e.rawError };
      }
      if (e instanceof HTTPError) return { kind: 'http', status: e.status };
      return { kind: 'network', message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Like `call`, but throws on anything but 2xx; for arranging, where a failure aborts the case. */
  async must<T = unknown>(method: 'get' | 'post' | 'patch' | 'put' | 'delete', route: Route, options: Parameters<Api['call']>[2] = {}): Promise<T> {
    const o = await this.call(method, route, options);
    if (o.kind === 'http' && o.status < 300) return o.body as T;
    throw new Error(`${method.toUpperCase()} ${route} failed: ${o.kind === 'http' ? `${o.status}${o.code ? `/${o.code}` : ''}` : o.message}`);
  }
}

export const toBits = (names: string[]): string =>
  new PermissionsBitField(names as (keyof typeof PermissionsBitField.Flags)[]).bitfield.toString();

export const fromBits = (bits: string | bigint): string[] => new PermissionsBitField(BigInt(bits)).toArray().sort();

export const ok = (o: Outcome) => o.kind === 'http' && o.status >= 200 && o.status < 300;
