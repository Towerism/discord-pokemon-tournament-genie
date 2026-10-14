import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canSnapshot,
  openLedger,
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

    const [onDisk] = await readLedgers(dir, guildId);
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

    expect(canSnapshot(await readLedgers(dir, guildId), 'everyone')).toBe(false);
    expect(canSnapshot(await readLedgers(dir, guildId), 'genieRole')).toBe(true);

    await markRestored(first, 'everyone');
    expect(canSnapshot(await readLedgers(dir, guildId), 'everyone')).toBe(true);
    await recordSnapshot(second, 'everyone', '2048');
    expect(canSnapshot(await readLedgers(dir, guildId), 'everyone')).toBe(false);
  });

  it('ignores ledgers recorded in another guild, so their snapshots and resources never reach this one', async () => {
    const other = await createLedger(dir, { runId: '20261013110000-0b0b', guildId: '1300000000000000999', kept: true });
    await recordSnapshot(other, 'everyone', '8');
    await createLedger(dir, { runId, guildId, kept: false });

    const ledgers = await readLedgers(dir, guildId);
    expect(ledgers.map((l) => l.runId)).toEqual([runId]);
    expect(canSnapshot(ledgers, 'everyone')).toBe(true);
  });

  it('reads no ledgers from an empty directory', async () => {
    expect(await readLedgers(dir, guildId)).toEqual([]);
  });

  it('snapshots genie\'s role separately from @everyone', async () => {
    const l = await createLedger(dir, { runId, guildId, kept: false });
    await recordSnapshot(l, 'genieRole', '4096');
    const [onDisk] = await readLedgers(dir, guildId);
    expect(onDisk?.genieRoleSnapshot).toBe('4096');
    expect(canSnapshot([onDisk!], 'genieRole')).toBe(false);
  });

  it('reads no ledgers when the output directory does not exist yet', async () => {
    expect(await readLedgers(join(dir, 'missing'), guildId)).toEqual([]);
  });

  it('reopens a run\'s ledger by id, and finds nothing for an unknown run', async () => {
    await createLedger(dir, { runId, guildId, kept: true });
    expect((await openLedger(dir, runId))?.data.kept).toBe(true);
    expect(await openLedger(dir, 'nope')).toBeUndefined();
  });
});
