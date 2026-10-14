import { DEFAULT_TRUSTED_PROXIES, contentSecurityPolicy } from '@towerism/selfhost-kit';
import { EXTRA_CSP } from './shared/csp';

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  devtools: { enabled: false },
  modules: ['@nuxt/ui', '@nuxt/eslint', 'nuxt-auth-utils', 'nuxt-security'],

  // nuxt-security nonces the HTML shell's inline scripts. The kit's securityHeadersPlugin
  // (server/plugins/security-headers.ts) puts the same headers on every other response and feeds the
  // shell's CSP and HSTS to nuxt-security, so the headers below only mirror the kit's set.
  security: {
    nonce: true,
    headers: {
      contentSecurityPolicy: contentSecurityPolicy({ httpsSite: false, nonce: true, extra: EXTRA_CSP }),
      strictTransportSecurity: false,
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: 'same-origin',
      crossOriginResourcePolicy: 'same-origin',
      originAgentCluster: '?1',
      referrerPolicy: 'no-referrer',
      xContentTypeOptions: 'nosniff',
      xDNSPrefetchControl: 'off',
      xDownloadOptions: false,
      xFrameOptions: 'DENY',
      xPermittedCrossDomainPolicies: 'none',
      xXSSProtection: '0',
      permissionsPolicy: { camera: [], 'display-capture': [], fullscreen: [], geolocation: [], microphone: [] },
    },
    // The kit's guards instead: rate limits through trusted proxies, jsonOnly and bodySizeLimit middleware.
    // Zod validates bodies. Same origin only: no CORS.
    rateLimiter: false,
    requestSizeLimiter: false,
    xssValidator: false,
    corsHandler: false,
    allowedMethodsRestricter: false,
    removeLoggers: false,
  },
  css: ['~/assets/css/main.css'],

  // Everything sits behind a login or the setup code, so the pages are a SPA.
  routeRules: { '/**': { ssr: false } },

  runtimeConfig: {
    // Overridden by env (NUXT_DATABASE_PATH etc.). The image sets /data/app.db (#12).
    databasePath: '.data/app.db',
    migrationsDir: 'server/db/migrations',
    // Filled from env or <data>/secrets/vault.key by server/bootstrap/launcher.ts.
    vaultKey: '',
    // Peers whose X-Forwarded-* headers are believed (NUXT_TRUSTED_PROXIES). Blank = this default.
    trustedProxies: DEFAULT_TRUSTED_PROXIES,
    // Per-client limits on login and setup unlock. NUXT_AUTH_RATE_LIMIT_*: optional tuning, not in the template.
    authRateLimit: {
      login: { max: 10, windowMs: 900_000 },
      setup: { max: 5, windowMs: 900_000 },
    },
    // Test-only overrides (NUXT_DISCORD_*), never in the template: tests point these at a fake Discord.
    discord: {
      apiUrl: 'https://discord.com/api',
      authorizeUrl: 'https://discord.com/oauth2/authorize',
      tokenUrl: 'https://discord.com/api/oauth2/token',
    },
    session: {
      // Secure always (ADR-0013); the launcher forces NUXT_SESSION_COOKIE_SECURE=true.
      cookie: { secure: true, sameSite: 'lax' },
    },
    public: {
      // Optional https:// origin served by Caddy (ADR-0013).
      siteUrl: '',
    },
  },

  nitro: {
    preset: 'node-server',
    // JSON errors keep the app's security headers.
    errorHandler: '~~/server/error',
    // The request id reaches every log record a request causes.
    experimental: { asyncContext: true },
  },

  typescript: {
    tsConfig: {
      compilerOptions: { noUncheckedIndexedAccess: true },
    },
  },
});
