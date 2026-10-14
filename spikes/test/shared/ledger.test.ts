import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canSnapshot,
  createLedger,
  createTracked,
  markRestored,
  readLedgers,
  recordSnapshot,
} from '../../src/shared/ledger.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spike-ledger-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const runId = '20261013120000-0a1f';
const guildId = '1300000000000000001';

describe('ledger', () => {
  it('keeps a created resource even when the next create fails', async () => {
    const ledger = await createLedger(dir, { runId, guildId, kept: false });
    await createTracked(ledger, { kind: 'category', name: `spike-${runId}-cat` }, async () => '1300000000000000100');
    await expect(
      createTracked(ledger, { kind: 'channel', name: `spike-${runId}-ch` }, async () => {
        throw new Error('Discord 500');
      }),
    ).rejects.toThrow('Discord 500');

    const [onDisk] = await readLedgers(dir);
    expect(onDisk?.resources).toEqual([{ kind: 'category', id: '1300000000000000100', name: `spike-${runId}-cat` }]);
  });

  it('refuses a resource name without the run prefix', async () => {
    const ledger = await createLedger(dir, { runId, guildId, kept: false });
    await expect(createTracked(ledger, { kind: 'channel', name: 'general' }, async () => '1')).rejects.toThrow(/prefix/);
  });

  it('writes the ledger file under the run id', async () => {
    await createLedger(dir, { runId, guildId, kept: true });
    const raw = JSON.parse(await readFile(join(dir, `ledger-${runId}.json`), 'utf8'));
    expect(raw).toMatchObject({ runId, guildId, kept: true, resources: [] });
  });

  it('refuses a new snapshot while another ledger still holds an unrestored one', async () => {
    const first = await createLedger(dir, { runId, guildId, kept: true });
    await recordSnapshot(first, 'everyone', '1024');
    const second = await createLedger(dir, { runId: '20261013130000-beef', guildId, kept: false });

    expect(canSnapshot(await readLedgers(dir), 'everyone')).toBe(false);
    expect(canSnapshot(await readLedgers(dir), 'genieRole')).toBe(true);

    await markRestored(first, 'everyone');
    expect(canSnapshot(await readLedgers(dir), 'everyone')).toBe(true);
    await recordSnapshot(second, 'everyone', '2048');
    expect(canSnapshot(await readLedgers(dir), 'everyone')).toBe(false);
  });

  it('reads no ledgers from an empty directory', async () => {
    expect(await readLedgers(dir)).toEqual([]);
  });
});
