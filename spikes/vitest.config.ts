import { defineConfig } from 'vitest/config';

// Branch-coverage targets are set by risk: the permission oracle and the guild-safety code
// get the highest bar; the spike-number helpers less. Discord and HTTP adapters (io/) are
// validated by the live recordings, not unit tests.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/io/**', 'src/cli.ts', 'src/**/types.ts'],
      thresholds: {
        'src/s3/{catalog,interpret,effective,stability,fixture,stage,profiles,runner,report}.ts': { branches: 95 },
        'src/shared/{guard,ledger,cleanup}.ts': { branches: 95 },
        'src/s1/**/*.ts': { branches: 85 },
        'src/s2/**/*.ts': { branches: 85 },
        'src/s4/**/*.ts': { branches: 85 },
      },
    },
  },
});
