import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FakeDiscord } from '../../server/modules/discord/fake';

export interface FakeCdnHttp {
  /** `127.0.0.1:<port>`, for the fetcher's allowlist. */
  host: string;
  close(): Promise<void>;
}

/**
 * Discord's CDN over HTTP, serving the fake's attachments while their URLs are valid. Points the fake's resolved URLs
 * at itself. A test makes one attachment misbehave through `fake.cdnBehaviour`.
 */
export async function startFakeCdnHttp(fake: FakeDiscord): Promise<FakeCdnHttp> {
  const server: Server = createServer((req, res) => {
    const answer = fake.cdnServe(`http://${req.headers.host}${req.url ?? '/'}`);
    if (answer.status === 302) return void res.writeHead(302, { location: answer.location }).end();
    if (answer.status !== 200 || !answer.body) return void res.writeHead(answer.status).end();
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    if (answer.behaviour === 'overlong') return void res.end(Buffer.concat([answer.body, answer.body]));
    if (answer.behaviour === 'stall') return void res.write(answer.body.subarray(0, 1));
    res.end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.cdnBase = `http://${host}`;
  return {
    host,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
