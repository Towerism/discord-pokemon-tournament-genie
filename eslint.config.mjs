// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs';

// Module rules (architecture §3, selfhost-kit ADR-0006). Checked by test/unit/eslint-rules.test.ts.

const TEST_FILES = ['**/*.test.ts', 'test/**'];

// h3 / Nitro / nuxt-auth-utils / server/utils auto-imports: invisible to no-restricted-imports.
const SERVER_AUTO_IMPORTS =
  /^(define(EventHandler|NitroPlugin|CachedEventHandler)|useRuntimeConfig|useNitroApp|useStorage|useEvent|createError|send(Error|Redirect|Stream)?|setResponse(Status|Header)|getRequestHeaders?|getQuery|getRouterParams?|readBody|getUserSession|setUserSession|requireUserSession|clearUserSession|useDatabase|useLogger|useSetup|useLogin|useSettings|useBot|useJobs|useVault)$/;

const NO_NUXT_IN_MODULES = {
  selector: `CallExpression[callee.name=${SERVER_AUTO_IMPORTS}]`,
  message: 'server/modules/* are plain TS: take dependencies as arguments instead of using h3/Nitro auto-imports.',
};

const NO_DISCORD_JS = {
  regex: '^(discord\\.js|@discordjs/.*)$',
  message: 'Only server/modules/discord/adapters/discordjs/ may import discord.js (ADR-0003).',
};
const NO_KIT_TESTING = {
  regex: '^@towerism/selfhost-kit/testing$',
  message: '@towerism/selfhost-kit/testing is for tests only (selfhost-kit ADR-0006).',
};
const NO_KIT_NITRO = {
  regex: '^@towerism/selfhost-kit/nitro$',
  message: 'Only server/{middleware,plugins,utils} and server/error.ts wire the kit’s Nitro adapters.',
};
const NO_NUXT_IMPORTS = {
  regex: '^(h3|nitropack|nitro|nuxt|nuxt-auth-utils|#imports|#app|#auth-utils|#nitro)(/.*)?$',
  message: 'server/modules/* are plain TS: no h3 or Nuxt imports.',
};

export default withNuxt(
  { ignores: ['.output/**', '.nuxt/**', 'server/db/migrations/**', 'spikes/**', 'coverage/**', 'playwright-report/**', 'test-results/**'] },
  {
    // Everywhere outside tests: no kit testing helpers, no discord.js outside its adapter.
    files: ['**/*.{ts,mts,js,mjs,vue}'],
    ignores: [...TEST_FILES, 'server/modules/discord/adapters/discordjs/**'],
    rules: { 'no-restricted-imports': ['error', { patterns: [NO_DISCORD_JS, NO_KIT_TESTING, NO_KIT_NITRO] }] },
  },
  {
    files: ['server/middleware/**', 'server/plugins/**', 'server/utils/**', 'server/error.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [NO_DISCORD_JS, NO_KIT_TESTING] }] },
  },
  {
    // Modules: plain TS, kit types only (Logger, Vault, Clock …), constructed in server/utils.
    files: ['server/modules/**/*.ts'],
    ignores: TEST_FILES,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [NO_NUXT_IMPORTS, NO_KIT_TESTING, NO_KIT_NITRO],
          paths: [],
        },
      ],
      'no-restricted-syntax': ['error', NO_NUXT_IN_MODULES],
    },
  },
  {
    files: ['server/modules/**/*.ts'],
    ignores: [...TEST_FILES, 'server/modules/discord/adapters/discordjs/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [NO_NUXT_IMPORTS, NO_KIT_TESTING, NO_KIT_NITRO, NO_DISCORD_JS] }],
    },
  },
  {
    // Modules import only types from the kit core; values (createVault, createLogger …) are built in server/utils.
    files: ['server/modules/**/*.ts'],
    ignores: TEST_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        NO_NUXT_IN_MODULES,
        {
          selector: "ImportDeclaration[source.value='@towerism/selfhost-kit'][importKind!='type'] > ImportSpecifier[importKind!='type']",
          message: 'server/modules/* import only types from @towerism/selfhost-kit; values are built in server/utils.',
        },
      ],
    },
  },
  {
    // Server code logs through the kit's logger (redacted, request-tagged), never the console (§10).
    files: ['server/**/*.ts'],
    ignores: TEST_FILES,
    rules: { 'no-console': 'error' },
  },
  {
    // Browser-side code builds Zod schemas under the CSP: take `z` from shared/zod (jitless).
    files: ['app/**/*.{ts,vue}', 'shared/**/*.ts'],
    ignores: ['shared/zod.ts', ...TEST_FILES],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            NO_DISCORD_JS,
            NO_KIT_TESTING,
            NO_KIT_NITRO,
            { regex: '^zod(/.*)?$', message: "Import z from shared/zod (jitless), not 'zod'." },
          ],
        },
      ],
    },
  },
);
