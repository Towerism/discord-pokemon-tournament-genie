/**
 * Downloads an attachment from Discord's CDN for a transcript (§6.5 step 3). The URL comes from Discord, but it is
 * still fetched as untrusted: only the CDN's hosts, https only, no redirects, a timeout, and a byte cap enforced on
 * what arrives (the declared size may lie). The file is streamed to disk and removed on any failure.
 */
import { createHash } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';

export const CDN_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];

export type FetchFailure = 'host_not_allowed' | 'redirect' | 'http_error' | 'too_large' | 'timeout' | 'network';
export type FetchResult = { ok: true; bytes: number; sha256: string } | { ok: false; reason: FetchFailure };
export type AttachmentFetcher = (url: string, opts: { maxBytes: number; destination: string }) => Promise<FetchResult>;

export function createAttachmentFetcher(opts: { hosts: readonly string[]; allowHttp: boolean; timeoutMs: number }): AttachmentFetcher {
  const allowed = (raw: string): boolean => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    const scheme = url.protocol === 'https:' || (opts.allowHttp && url.protocol === 'http:');
    return scheme && !url.username && !url.password && opts.hosts.includes(url.host);
  };

  return async (url, { maxBytes, destination }) => {
    if (!allowed(url)) return { ok: false, reason: 'host_not_allowed' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), opts.timeoutMs);
    const partial = `${destination}.part`;
    let file: Awaited<ReturnType<typeof open>> | null = null;
    const fail = async (reason: FetchFailure): Promise<FetchResult> => {
      controller.abort();
      await file?.close().catch(() => undefined);
      await rm(partial, { force: true });
      return { ok: false, reason };
    };
    try {
      const response = await fetch(url, { redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) return await fail('redirect');
      if (!response.ok || !response.body) return await fail('http_error');
      file = await open(partial, 'w', 0o600);
      const hash = createHash('sha256');
      let bytes = 0;
      let tooLarge = false;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          tooLarge = true;
          break;
        }
        hash.update(chunk);
        await file.write(chunk);
      }
      if (tooLarge) return await fail('too_large');
      await file.sync();
      await file.close();
      file = null;
      await rename(partial, destination);
      return { ok: true, bytes, sha256: hash.digest('hex') };
    } catch {
      const timedOut = controller.signal.aborted && (controller.signal.reason as Error | undefined)?.name === 'TimeoutError';
      return await fail(timedOut ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  };
}
