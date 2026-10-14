import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['shared/**/*.ts', 'server/**/*.ts'],
      exclude: ['**/*.test.ts', 'server/db/migrations/**', 'server/modules/discord/adapters/**'],
      // Set by risk (architecture §11): the access decision gates every login and route.
      thresholds: {
        'shared/access/**': { branches: 95 },
        'server/modules/setup/**': { branches: 90 },
        'server/modules/jobs/**': { branches: 85 },
        'server/bot/**': { branches: 85 },
      },
    },
    projects: [
      {
        // Plain TS: shared/, server modules, bootstrap, the bot router, config and structure checks.
        test: {
          name: 'unit',
          environment: 'node',
          include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'test/unit/**/*.test.ts'],
        },
      },
      {
        // The built app (.output/), started through the production launcher against a throwaway data dir
        // and a fake Discord, and driven over HTTP.
        test: {
          name: 'server',
          environment: 'node',
          include: ['test/server/**/*.test.ts'],
          globalSetup: ['test/server/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
