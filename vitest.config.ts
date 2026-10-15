import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // The unit project's reach. Routes, plugins and server/utils run in the built app (server project).
      include: ['shared/**/*.ts', 'server/modules/**/*.ts', 'server/bot/**/*.ts', 'server/bootstrap/env.ts'],
      exclude: ['**/*.test.ts', 'server/db/migrations/**', 'server/modules/discord/adapters/**'],
      // Set by risk (architecture §11): the access decision gates every login and route.
      thresholds: {
        'shared/access/**': { branches: 95 },
        // M2: where a bug leaks a channel (architecture §11), then crash safety, then the planning modules.
        'shared/discord/**': { branches: 95 },
        'shared/blueprints/**': { branches: 95 },
        'server/modules/provisioning/audit.ts': { branches: 95 },
        'server/modules/provisioning/**': { branches: 90 },
        'server/modules/directory/**': { branches: 85 },
        'server/modules/event-days/**': { branches: 85 },
        // M3: a wrong removal in the import diff revokes channel access; the adapter maps attendance's failures.
        'server/modules/attendance-import/**': { branches: 90 },
        'server/modules/attendance/**': { branches: 85 },
        'server/modules/setup/**': { branches: 90 },
        'server/modules/jobs/**': { branches: 85 },
        // M4: a wrong or doubled penalty lands in the submitted CSV; a leaked one exposes a (often minor) player.
        'server/modules/penalties/**': { branches: 90 },
        'shared/penalties/**': { branches: 90 },
        'server/bot/**': { branches: 85 },
        // Every boot passes through it: a wrong zone shifts every start time, a missed refusal answers 500s.
        'server/bootstrap/env.ts': { branches: 100 },
        // M5: where a bug deletes a channel before its content is safe, or serves a transcript to the wrong person.
        'shared/discord/lock.ts': { branches: 95 },
        'shared/closeout/**': { branches: 95 },
        'server/modules/closeout/adapters/**': { branches: 95 },
        'server/modules/closeout/**': { branches: 90 },
      },
    },
    projects: [
      {
        // Plain TS: shared/, server modules, bootstrap, the bot router, config and structure checks.
        test: {
          name: 'unit',
          environment: 'node',
          // The store's time zone, so start times and day dates are tested off UTC.
          env: { TZ: 'America/Chicago' },
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
      {
        // S3's table against the discord.js adapter on a real test guild: run by a person before each release
        // (`pnpm test:contract:discord`), never in CI; every case is skipped without its env vars.
        test: {
          name: 'contract-discord',
          environment: 'node',
          include: ['test/contract/**/*.contract.test.ts'],
          testTimeout: 60_000,
        },
      },
    ],
  },
});
