/**
 * Production entry point, bundled to `.output/launcher.mjs` by `pnpm build`. Resolves secrets and settings
 * into `process.env` before Nitro loads (Nitro reads its runtime config from env once, at import).
 */
import { runLauncher } from '@towerism/selfhost-kit';
import { prepareGenieEnv } from './env';
import { startupLogger } from './logging';

await runLauncher({
  prepare: prepareGenieEnv,
  server: new URL('./server/index.mjs', import.meta.url),
  logger: startupLogger(),
});
