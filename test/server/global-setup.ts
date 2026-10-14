import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Builds the production output once per run. TEST_SKIP_BUILD=1 reuses `.output/` while iterating. */
export default function setup() {
  if (process.env.TEST_SKIP_BUILD === '1' && existsSync('.output/launcher.mjs')) return;
  execFileSync('pnpm', ['build'], { stdio: 'inherit' });
}
