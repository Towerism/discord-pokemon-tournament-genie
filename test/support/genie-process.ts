import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { type TempSecretsDir, tempSecretsDir } from '@towerism/selfhost-kit/testing';

const ROOT = resolve(import.meta.dirname, '../..');
const PRELOAD = resolve(ROOT, 'test/support/discord-fetch-redirect.mjs');

export interface Genie {
  url: string;
  port: number;
  dataDir: TempSecretsDir;
  /** Everything the process wrote to stdout and stderr. */
  log(): string;
  /** The setup code from the latest boot's log line. */
  setupCode(): string;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The built app, started through the production launcher (`.output/launcher.mjs`) with a throwaway data dir,
 * pointed at a fake Discord. Waits for `/readyz` with a deadline, never a fixed sleep.
 */
export async function startGenie(opts: { discordUrl: string; port?: number; env?: Record<string, string> }): Promise<Genie> {
  const dataDir = tempSecretsDir();
  const port = opts.port ?? (await freePort());
  let output = '';
  let child: ChildProcess | undefined;

  async function boot() {
    child = spawn(process.execPath, ['--import', PRELOAD, resolve(ROOT, '.output/launcher.mjs')], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
        TZ: 'America/Chicago',
        PORT: String(port),
        HOST: '127.0.0.1',
        NUXT_DATABASE_PATH: dataDir.databasePath,
        NUXT_DISCORD_API_URL: `${opts.discordUrl}/api`,
        NUXT_DISCORD_AUTHORIZE_URL: `${opts.discordUrl}/oauth2/authorize`,
        NUXT_DISCORD_TOKEN_URL: `${opts.discordUrl}/api/oauth2/token`,
        GENIE_TEST_DISCORD_URL: opts.discordUrl,
        // The fake serves Discord's CDN too, over plain http.
        NUXT_DISCORD_CDN_HOSTS: new URL(opts.discordUrl).host,
        NUXT_DISCORD_CDN_ALLOW_HTTP: 'true',
        NO_COLOR: '1',
        ...opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()));
    await waitForReady(`http://127.0.0.1:${port}`, () => child!.exitCode, () => output);
  }

  async function stop() {
    const current = child;
    if (!current || current.exitCode !== null) return;
    const exited = new Promise((resolve) => current.once('exit', resolve));
    current.kill('SIGTERM');
    await exited;
  }

  try {
    await boot();
  } catch (err) {
    await stop();
    dataDir.cleanup();
    throw err;
  }
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    dataDir,
    log: () => output,
    setupCode() {
      const codes = [...output.matchAll(/enter this setup code: ([A-Z0-9]{4}-[A-Z0-9]{4})/g)];
      const code = codes.at(-1)?.[1];
      if (!code) throw new Error(`No setup code in the log:\n${output}`);
      return code;
    },
    async restart() {
      await stop();
      await boot();
    },
    async stop() {
      await stop();
      dataDir.cleanup();
    },
  };
}

/**
 * Starts the built launcher with `env` and waits for it to exit on its own (a boot the launcher refuses).
 * Waits on the exit event with a deadline, never a sleep; the throwaway data dir is removed either way.
 */
export async function bootRefused(env: Record<string, string>): Promise<{ exitCode: number | null; log: string }> {
  const dataDir = tempSecretsDir();
  let output = '';
  const child = spawn(process.execPath, [resolve(ROOT, '.output/launcher.mjs')], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      PORT: String(await freePort()),
      HOST: '127.0.0.1',
      NUXT_DATABASE_PATH: dataDir.databasePath,
      NO_COLOR: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  try {
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      const timer = setTimeout(() => reject(new Error(`Genie was still running after 30 s:\n${output}`)), 30_000);
      // `close`, not `exit`: it fires once stdout and stderr are drained, so the log is complete.
      child.once('close', (code) => {
        clearTimeout(timer);
        resolveExit(code);
      });
    });
    return { exitCode, log: output };
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    dataDir.cleanup();
  }
}

async function waitForReady(url: string, exitCode: () => number | null, log: () => string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exitCode() !== null) throw new Error(`Genie exited with ${exitCode()}:\n${log()}`);
    try {
      const res = await fetch(`${url}/readyz`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Genie wasn't ready within 30 s:\n${log()}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}
