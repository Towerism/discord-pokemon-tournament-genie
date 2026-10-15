import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAttachmentFetcher } from './fetcher';

const BODY = Buffer.from('a'.repeat(1000));
let server: Server;
let host: string;
let dir: string;
const requests: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    switch (req.url) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'image/png' }).end(BODY);
        return;
      case '/redirect':
        res.writeHead(302, { location: '/ok' }).end();
        return;
      case '/error':
        res.writeHead(500).end('nope');
        return;
      case '/overlong':
        res.writeHead(200);
        res.write(BODY);
        res.end(BODY);
        return;
      case '/stall':
        res.writeHead(200);
        res.write(BODY.subarray(0, 10));
        return; // never ends
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genie-fetch-'));
  requests.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fetcher = (over: Partial<Parameters<typeof createAttachmentFetcher>[0]> = {}) =>
  createAttachmentFetcher({ hosts: [host], allowHttp: true, timeoutMs: 1000, ...over });
const target = () => join(dir, 'file.bin');

describe('the attachment fetcher', () => {
  it('streams an allowed file to its destination with its hash', async () => {
    const result = await fetcher()(`http://${host}/ok`, { maxBytes: 1000, destination: target() });
    expect(result).toEqual({ ok: true, bytes: 1000, sha256: createHash('sha256').update(BODY).digest('hex') });
    expect(readFileSync(target())).toEqual(BODY);
    expect(readdirSync(dir)).toEqual(['file.bin']);
  });

  it('never follows a redirect', async () => {
    expect(await fetcher()(`http://${host}/redirect`, { maxBytes: 1000, destination: target() })).toEqual({ ok: false, reason: 'redirect' });
    expect(requests).toEqual(['/redirect']);
  });

  it('refuses an error answer, a body over the cap and a stalled one, leaving no file', async () => {
    expect(await fetcher()(`http://${host}/error`, { maxBytes: 1000, destination: target() })).toEqual({ ok: false, reason: 'http_error' });
    expect(await fetcher()(`http://${host}/overlong`, { maxBytes: 1000, destination: target() })).toEqual({ ok: false, reason: 'too_large' });
    expect(await fetcher({ timeoutMs: 200 })(`http://${host}/stall`, { maxBytes: 1000, destination: target() })).toEqual({ ok: false, reason: 'timeout' });
    expect(existsSync(target())).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('asks nothing of a host outside the allowlist, or of plain http unless allowed', async () => {
    expect(await fetcher()(`http://127.0.0.2:1/ok`, { maxBytes: 1000, destination: target() })).toEqual({ ok: false, reason: 'host_not_allowed' });
    expect(await fetcher({ allowHttp: false })(`http://${host}/ok`, { maxBytes: 1000, destination: target() })).toEqual({ ok: false, reason: 'host_not_allowed' });
    expect(await fetcher()('not a url', { maxBytes: 1000, destination: target() })).toEqual({ ok: false, reason: 'host_not_allowed' });
    expect(requests).toEqual([]);
  });

  it('answers network when nothing listens', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const gone = `127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise((resolve) => closed.close(resolve));
    expect(await createAttachmentFetcher({ hosts: [gone], allowHttp: true, timeoutMs: 1000 })(`http://${gone}/ok`, { maxBytes: 10, destination: target() })).toEqual({
      ok: false,
      reason: 'network',
    });
  });
});
