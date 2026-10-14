import { type Env, InvalidConfigError, prepareRuntimeEnv } from '@towerism/selfhost-kit';
import { SECRETS } from './secrets';

/** Optional tuning for `runtimeConfig.authRateLimit`; never in the template. */
export const RATE_LIMIT_VARS = [
  'NUXT_AUTH_RATE_LIMIT_LOGIN_MAX',
  'NUXT_AUTH_RATE_LIMIT_LOGIN_WINDOW_MS',
  'NUXT_AUTH_RATE_LIMIT_SETUP_MAX',
  'NUXT_AUTH_RATE_LIMIT_SETUP_WINDOW_MS',
];

export const DEFAULT_PORT = '3001';

/**
 * The server's env, worked out before Nitro loads. On top of the kit's steps:
 * - session cookies are always `Secure` (ADR-0013; Chrome treats `http://localhost` as secure);
 * - the default port is 3001, beside attendance's 3000 (ADR-0009);
 * - `NUXT_PUBLIC_SITE_URL`, when set, must be an https origin (ADR-0013).
 */
export function prepareGenieEnv(input: Env) {
  const env: Env = { ...input, NUXT_SESSION_COOKIE_SECURE: 'true' };
  if (!env.PORT && !env.NITRO_PORT) env.PORT = DEFAULT_PORT;
  return prepareRuntimeEnv(env, { secrets: SECRETS, positiveIntegerVars: RATE_LIMIT_VARS, validate: validateSiteUrl });
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
