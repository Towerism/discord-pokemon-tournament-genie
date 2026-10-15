import { type Env, InvalidConfigError, prepareRuntimeEnv } from '@towerism/selfhost-kit';
import { canonicalTimeZone } from '../../shared/time';
import { SECRETS } from './secrets';

/** Optional tuning for `runtimeConfig.authRateLimit`; never in the template. */
export const RATE_LIMIT_VARS = [
  'NUXT_AUTH_RATE_LIMIT_LOGIN_MAX',
  'NUXT_AUTH_RATE_LIMIT_LOGIN_WINDOW_MS',
  'NUXT_AUTH_RATE_LIMIT_SETUP_MAX',
  'NUXT_AUTH_RATE_LIMIT_SETUP_WINDOW_MS',
];

export const DEFAULT_PORT = '3001';

/** The store's zone when `TZ` is blank; the Dockerfile's `ENV TZ` matches it. */
export const DEFAULT_TIME_ZONE = 'America/Chicago';

/**
 * The server's env, worked out before Nitro loads. On top of the kit's steps:
 * - session cookies are always `Secure` (ADR-0013; Chrome treats `http://localhost` as secure);
 * - the default port is 3001, beside attendance's 3000 (ADR-0009);
 * - the store's zone (`TZ`, §5.1) is Central unless set, and an unknown one stops the boot;
 * - `NUXT_PUBLIC_SITE_URL`, when set, must be an https origin (ADR-0013).
 */
export function prepareGenieEnv(input: Env) {
  const env: Env = { ...input, NUXT_SESSION_COOKIE_SECURE: 'true' };
  if (!env.PORT && !env.NITRO_PORT) env.PORT = DEFAULT_PORT;
  // Before the kit's steps, so a refused zone writes no secret files.
  const zone = storeTimeZone(env.TZ);
  env.TZ = zone.name;
  const prepared = prepareRuntimeEnv(env, { secrets: SECRETS, positiveIntegerVars: RATE_LIMIT_VARS, validate: validateSiteUrl });
  prepared.log.push(`Store time zone: ${zone.name} (${zone.defaulted ? 'default; set TZ to change it' : 'from TZ'})`);
  return prepared;
}

/**
 * Unraid sends a blank Timezone field as `TZ=""`, which overrides the image's `ENV TZ` and makes Node resolve
 * ICU's `Etc/Unknown`; `Intl` rejects that, so every start time would fail. Blank means the default here.
 */
function storeTimeZone(raw: string | undefined): { name: string; defaulted: boolean } {
  const name = raw?.trim();
  if (!name) return { name: DEFAULT_TIME_ZONE, defaulted: true };
  if (canonicalTimeZone(name) === null) {
    throw new InvalidConfigError(
      `TZ must be an IANA time zone like ${DEFAULT_TIME_ZONE} (got ${JSON.stringify(raw)}). ` +
        `Fix it, or clear it to use ${DEFAULT_TIME_ZONE}.`,
    );
  }
  return { name, defaulted: false };
}

function validateSiteUrl(env: Env): void {
  const raw = env.NUXT_PUBLIC_SITE_URL?.trim();
  if (!raw) return;
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  const isOrigin =
    url !== undefined &&
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash &&
    !raw.includes('?') &&
    !raw.includes('#');
  if (!isOrigin) {
    throw new InvalidConfigError(
      `NUXT_PUBLIC_SITE_URL must be the https:// address Caddy serves Genie on, like https://genie.example.com ` +
        `(no path, query or fragment). Leave it empty to reach /setup only through an SSH tunnel to localhost.`,
    );
  }
}
