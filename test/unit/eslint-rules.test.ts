import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

// The module rules of architecture §3 and selfhost-kit ADR-0006, checked by linting small sources at the paths
// they would live at. Each violation must be reported by its rule; each control must stay clean.

let eslint: ESLint;
beforeAll(() => {
  // `nuxt build` regenerates .nuxt/ without the ESLint config that `nuxt prepare` writes.
  if (!existsSync('.nuxt/eslint.config.mjs')) execFileSync('pnpm', ['exec', 'nuxt', 'prepare'], { stdio: 'ignore' });
  eslint = new ESLint({ cwd: process.cwd() });
}, 60_000);

async function rulesFor(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path });
  return (result?.messages ?? []).map((m) => m.ruleId ?? m.message);
}

describe('module boundary rules', () => {
  it.each([
    ['a module importing h3', 'server/modules/example/bad.ts', "import { createError } from 'h3';\nexport const x = createError;\n", 'no-restricted-imports'],
    ['a module importing discord.js', 'server/modules/example/bad.ts', "import { Client } from 'discord.js';\nexport const x = Client;\n", 'no-restricted-imports'],
    ['a module importing a kit value', 'server/modules/example/bad.ts', "import { createVault } from '@towerism/selfhost-kit';\nexport const x = createVault;\n", 'no-restricted-syntax'],
    ['a module using a Nitro auto-import', 'server/modules/example/bad.ts', 'export const x = () => useRuntimeConfig();\n', 'no-restricted-syntax'],
    ['a module importing the kit Nitro adapters', 'server/modules/example/bad.ts', "import { jsonOnly } from '@towerism/selfhost-kit/nitro';\nexport const x = jsonOnly;\n", 'no-restricted-imports'],
    ['a route importing the kit testing helpers', 'server/api/example.get.ts', "import { fakeClock } from '@towerism/selfhost-kit/testing';\nexport const x = fakeClock;\n", 'no-restricted-imports'],
    ['a route importing discord.js', 'server/api/example.get.ts', "import { Client } from 'discord.js';\nexport const x = Client;\n", 'no-restricted-imports'],
    ['server code using the console', 'server/utils/example.ts', "export const x = () => console.log('hi');\n", 'no-console'],
    ['a page importing zod directly', 'app/composables/example.ts', "import { z } from 'zod';\nexport const x = z;\n", 'no-restricted-imports'],
  ])('reports %s', async (_name, path, code, rule) => {
    expect(await rulesFor(path, code)).toContain(rule);
  });

  it.each([
    ['the discord.js adapter importing discord.js', 'server/modules/discord/adapters/discordjs/example.ts', "import { Client } from 'discord.js';\nexport const x = Client;\n"],
    ['a module importing kit types', 'server/modules/example/good.ts', "import type { Logger } from '@towerism/selfhost-kit';\nexport type X = Logger;\n"],
    ['server/utils building kit values', 'server/utils/example.ts', "import { createVault } from '@towerism/selfhost-kit';\nexport const x = createVault;\n"],
    ['a test importing the kit testing helpers', 'server/modules/example/good.test.ts', "import { fakeClock } from '@towerism/selfhost-kit/testing';\nexport const x = fakeClock;\n"],
  ])('allows %s', async (_name, path, code) => {
    expect(await rulesFor(path, code)).toEqual([]);
  });
});
