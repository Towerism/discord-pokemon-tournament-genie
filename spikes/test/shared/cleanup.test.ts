import { describe, expect, it } from 'vitest';
import { applyCleanup, planCleanup, type CleanupPort, type GuildSnapshot } from '../../src/shared/cleanup.js';
import type { Ledger } from '../../src/shared/ledger.js';

const r0 = '20261013100000-0000';
const r1 = '20261013110000-0a1f';
const r2 = '20261013120000-beef';
const guildId = '1300000000000000001';

function ledger(runId: string, over: Partial<Ledger> = {}): Ledger {
  return { runId, guildId, kept: false, resources: [], restored: [], ...over };
}

const r1Ledger = ledger(r1, {
  resources: [
    { kind: 'category', id: '11', name: `spike-${r1}-cat` },
    { kind: 'channel', id: '12', name: `spike-${r1}-ch` },
    { kind: 'role', id: '13', name: `spike-${r1}-organizer` },
  ],
});
const r2Ledger = ledger(r2, {
  kept: true,
  everyoneBaseSnapshot: '1024',
  resources: [{ kind: 'channel', id: '22', name: `spike-${r2}-ch` }],
});

function guildWith(extra: GuildSnapshot['channels'] = []): GuildSnapshot {
  return {
    channels: [
      { id: '11', name: `spike-${r1}-cat` },
      { id: '12', name: `spike-${r1}-ch` },
      { id: '22', name: `spike-${r2}-ch` },
      { id: '90', name: `spike-${r0}-x` },
      { id: '91', name: 'general' },
      { id: '92', name: 'spikes-notes' },
      ...extra,
    ],
    roles: [
      { id: '13', name: `spike-${r1}-organizer` },
      { id: '93', name: 'Moderators' },
    ],
  };
}

const ids = (plan: ReturnType<typeof planCleanup>) => plan.delete.map((r) => r.id).sort();

describe('planCleanup', () => {
  const ledgers = [r1Ledger, r2Ledger];

  it('ends a run by deleting only that run\'s ledgered resources', () => {
    expect(ids(planCleanup({ kind: 'end-of-run', runId: r1 }, ledgers, guildWith()))).toEqual(['11', '12', '13']);
  });

  it('ends a kept run without deleting or restoring anything', () => {
    const plan = planCleanup({ kind: 'end-of-run', runId: r2 }, ledgers, guildWith());
    expect(plan.delete).toEqual([]);
    expect(plan.restoreEveryone).toBeUndefined();
  });

  it('sweeps only unledgered spike- resources as orphans, sparing kept ledgers', () => {
    expect(ids(planCleanup({ kind: 'orphans' }, ledgers, guildWith()))).toEqual(['90']);
  });

  it('deletes everything spike- with --all, kept ledgers included', () => {
    expect(ids(planCleanup({ kind: 'all' }, ledgers, guildWith()))).toEqual(['11', '12', '13', '22', '90']);
  });

  it('never plans to delete a resource without the spike- prefix', () => {
    for (const scope of [{ kind: 'orphans' }, { kind: 'all' }, { kind: 'run', runId: r1 }] as const) {
      const planned = ids(planCleanup(scope, ledgers, guildWith()));
      expect(planned).not.toContain('91');
      expect(planned).not.toContain('92');
      expect(planned).not.toContain('93');
    }
  });

  it('ignores a ledger entry whose name lost the prefix (a hand-edited ledger)', () => {
    const tampered = ledger(r1, { resources: [{ kind: 'channel', id: '91', name: 'general' }] });
    expect(ids(planCleanup({ kind: 'run', runId: r1 }, [tampered], guildWith()))).toEqual([]);
  });

  it('cleans a kept run explicitly and restores its snapshots', () => {
    const withRole = { ...r2Ledger, genieRoleSnapshot: '4096' };
    const plan = planCleanup({ kind: 'run', runId: r2 }, [r1Ledger, withRole], guildWith());
    expect(ids(plan)).toEqual(['22']);
    expect(plan.restoreEveryone).toBe('1024');
    expect(plan.restoreGenieRole).toBe('4096');
  });

  it('restores nothing that is already restored', () => {
    const done = { ...r2Ledger, restored: ['everyone' as const] };
    expect(planCleanup({ kind: 'run', runId: r2 }, [done], guildWith()).restoreEveryone).toBeUndefined();
  });

  it('restores the oldest unrestored snapshot with --all', () => {
    const older = ledger(r0, { everyoneBaseSnapshot: '512' });
    const plan = planCleanup({ kind: 'all' }, [r2Ledger, older], guildWith());
    expect(plan.restoreEveryone).toBe('512');
  });

  it('deletes children before parents: threads, channels, categories, then roles', () => {
    const l = ledger(r1, {
      resources: [
        { kind: 'role', id: '4', name: `spike-${r1}-r` },
        { kind: 'category', id: '3', name: `spike-${r1}-c` },
        { kind: 'channel', id: '2', name: `spike-${r1}-ch` },
        { kind: 'thread', id: '1', name: `spike-${r1}-t` },
      ],
    });
    expect(planCleanup({ kind: 'run', runId: r1 }, [l], { channels: [], roles: [] }).delete.map((r) => r.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
  });

  it('treats an unknown run as nothing to clean', () => {
    expect(planCleanup({ kind: 'run', runId: 'nope' }, ledgers, guildWith()).delete).toEqual([]);
  });
});

describe('applyCleanup', () => {
  function fakeGuild(initial: string[], gone: string[] = []) {
    const present = new Set(initial);
    const restores: string[] = [];
    const port: CleanupPort = {
      async deleteResource(ref) {
        if (gone.includes(ref.id) || !present.has(ref.id)) return { status: 404, code: 10003 };
        present.delete(ref.id);
        return { status: 204 };
      },
      async restoreEveryone(bits) {
        restores.push(`everyone:${bits}`);
      },
      async restoreGenieRole(bits) {
        restores.push(`genie:${bits}`);
      },
    };
    return { port, present, restores };
  }

  it('counts an already-gone resource as deleted and succeeds', async () => {
    const g = fakeGuild(['12'], ['11']);
    const result = await applyCleanup(
      {
        delete: [
          { kind: 'channel', id: '11', name: `spike-${r1}-a` },
          { kind: 'channel', id: '12', name: `spike-${r1}-b` },
        ],
      },
      g.port,
    );
    expect(result.ok).toBe(true);
    expect(result.alreadyGone).toEqual(['11']);
    expect([...g.present]).toEqual([]);
  });

  it('reports failure when a delete is refused', async () => {
    const port: CleanupPort = {
      deleteResource: async () => ({ status: 403, code: 50013 }),
      restoreEveryone: async () => {},
      restoreGenieRole: async () => {},
    };
    const result = await applyCleanup({ delete: [{ kind: 'role', id: '13', name: `spike-${r1}-r` }] }, port);
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual([{ id: '13', status: 403, code: 50013 }]);
  });

  it('applies the planned restores', async () => {
    const g = fakeGuild([]);
    await applyCleanup({ delete: [], restoreEveryone: '1024', restoreGenieRole: '4096' }, g.port);
    expect(g.restores).toEqual(['everyone:1024', 'genie:4096']);
  });

  it('counts an already-deleted role (Unknown Role) as deleted', async () => {
    const port: CleanupPort = {
      deleteResource: async () => ({ status: 404, code: 10011 }),
      restoreEveryone: async () => {},
      restoreGenieRole: async () => {},
    };
    const result = await applyCleanup({ delete: [{ kind: 'role', id: '13', name: `spike-${r1}-r` }] }, port);
    expect(result).toMatchObject({ ok: true, alreadyGone: ['13'] });
  });

  it('does not treat a 404 with another code as gone', async () => {
    const port: CleanupPort = {
      deleteResource: async () => ({ status: 404, code: 10004 }),
      restoreEveryone: async () => {},
      restoreGenieRole: async () => {},
    };
    expect((await applyCleanup({ delete: [{ kind: 'channel', id: '1', name: `spike-${r1}-c` }] }, port)).ok).toBe(false);
  });
});
