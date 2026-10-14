import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/);
const botToken = z.string().regex(/^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/);
const secret = z.string().min(8).regex(/^\S+$/);

const schema = {
  GENIE_SPIKE_GUILD_ID: snowflake,
  GENIE_SPIKE_ARRANGER_TOKEN: botToken,
  GENIE_SPIKE_GENIE_TOKEN: botToken,
  GENIE_SPIKE_GENIE_CLIENT_ID: snowflake,
  GENIE_SPIKE_GENIE_CLIENT_SECRET: secret,
  GENIE_SPIKE_PROBE_A_TOKEN: botToken,
  GENIE_SPIKE_PROBE_B_TOKEN: botToken,
} as const;

export type ConfigKey = keyof typeof schema;
export type Config = Partial<Record<ConfigKey, string>>;

const SECRET_KEYS: ConfigKey[] = [
  'GENIE_SPIKE_ARRANGER_TOKEN',
  'GENIE_SPIKE_GENIE_TOKEN',
  'GENIE_SPIKE_GENIE_CLIENT_SECRET',
  'GENIE_SPIKE_PROBE_A_TOKEN',
  'GENIE_SPIKE_PROBE_B_TOKEN',
];

export const ALL_KEYS = Object.keys(schema) as ConfigKey[];

export type ConfigResult =
  | { ok: true; config: Config; secrets: string[] }
  | { ok: false; message: string };

/** Validates only the keys a command needs. Error messages name variables, never values. */
export function loadConfig(env: Record<string, string | undefined>, needed: ConfigKey[] = ALL_KEYS): ConfigResult {
  const problems: string[] = [];
  const config: Config = {};
  for (const key of needed) {
    const value = env[key];
    if (value === undefined || value === '') {
      problems.push(`${key} is missing`);
      continue;
    }
    if (!schema[key].safeParse(value).success) {
      problems.push(`${key} is malformed`);
      continue;
    }
    config[key] = value;
  }
  if (problems.length > 0) {
    return { ok: false, message: `Invalid configuration (see spikes/.env.example): ${problems.join('; ')}` };
  }
  const secrets = SECRET_KEYS.map((k) => config[k]).filter((v): v is string => v !== undefined);
  return { ok: true, config, secrets };
}
