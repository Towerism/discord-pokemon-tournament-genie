import { randomBytes } from 'node:crypto';
import { mkdir, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type ConfigKey } from '../shared/config.js';
import { guard } from '../shared/guard.js';
import { newRunId } from '../shared/ids.js';
import { createRedactor } from '../shared/redact.js';
import { Api } from './rest.js';

export const SPIKES_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const OUT_DIR = join(SPIKES_DIR, 'out');
export const REPO_DIR = join(SPIKES_DIR, '..');

export class ExitError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}

let redact: (s: string) => string = (s) => s;
export const log = (...parts: unknown[]) => console.log(redact(parts.map(String).join(' ')));
export const warn = (...parts: unknown[]) => console.error(redact(parts.map(String).join(' ')));

/** Validates config, makes `spikes/out/` writable, and installs the redactor. */
export async function startSession(needed: ConfigKey[]) {
  const result = loadConfig(process.env, needed);
  if (!result.ok) throw new ExitError(1, result.message);
  redact = createRedactor(result.secrets);
  await mkdir(OUT_DIR, { recursive: true });
  try {
    await access(OUT_DIR, constants.W_OK);
  } catch {
    throw new ExitError(1, `${OUT_DIR} is not writable`);
  }
  return result.config;
}

export const runId = () => newRunId(new Date(), (n) => randomBytes(n));

/** Refuse with exit 2 unless this is the configured, marked test guild. */
export async function guarded(api: Api, guildId: string): Promise<{ id: string; name: string; owner_id: string }> {
  const guild = await api.must<{ id: string; name: string; owner_id: string }>('get', `/guilds/${guildId}`);
  const g = guard(guild, guildId);
  if (!g.ok) throw new ExitError(2, `guard refused: ${g.reason}`);
  return guild;
}

export async function whoAmI(api: Api): Promise<{ id: string; username: string; bot?: boolean }> {
  return api.must('get', '/users/@me');
}
