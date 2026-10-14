import { describe, expect, it } from 'vitest';
import { buildCatalog, findCase } from '../../src/s3/catalog.js';
import { runCase, runPass, runWriteCase } from '../../src/s3/runner.js';
import type { EffectiveCase, WriteCase } from '../../src/s3/types.js';
import { archivedBlock, ctx, denied, fakePorts, flaky, ok } from './fakes.js';

const eff = (id: string) => findCase(id) as EffectiveCase;
const wc = (id: string) => findCase(id) as WriteCase;

describe('runCase', () => {
  it('records the interpreted outcome of every action and derives effective permissions', async () => {
    const { ports } = fakePorts({ act: { send: [denied], reactNew: [denied] } });
    const r = await runCase(eff('R4-default-locked-staffer'), ports, ctx);
    expect(r.status).toBe('ok');
    expect(r.observed.view).toEqual({ result: 'allowed', status: 200 });
    expect(r.observed.send).toEqual({ result: 'denied', status: 403, code: 50013 });
    expect(r.effective.SendMessages).toBe(false);
    expect(r.effective.AddReactions).toBe(false);
    expect(r.effective.ViewChannel).toBe(true);
  });

  it('attempts actions in the fixed order with send last', async () => {
    const { ports, attempts } = fakePorts();
    await runCase(eff('R2-default-open-staffer'), ports, ctx);
    expect(attempts).toEqual(['view', 'readHistory', 'reactExisting', 'reactNew', 'createPublicThread', 'createPrivateThread', 'send']);
  });

  it('retries an inconclusive action and keeps the first conclusive answer', async () => {
    const { ports, attempts } = fakePorts({ act: { view: [flaky, flaky, ok()] } });
    const r = await runCase(eff('R2-default-open-staffer'), ports, ctx);
    expect(r.status).toBe('ok');
    expect(r.observed.view?.result).toBe('allowed');
    expect(attempts.filter((a) => a === 'view')).toHaveLength(3);
  });

  it('marks the case inconclusive only after three inconclusive attempts', async () => {
    const { ports, attempts } = fakePorts({ act: { view: [flaky] } });
    const r = await runCase(eff('R2-default-open-staffer'), ports, ctx);
    expect(r.status).toBe('inconclusive');
    expect(r.failure).toMatch(/view/);
    expect(attempts.filter((a) => a === 'view')).toHaveLength(3);
  });

  it('archived thread: actions before send see it archived; reactions blocked are conclusive; send unarchives it', async () => {
    const { ports, attempts } = fakePorts({ act: { reactExisting: [archivedBlock], reactNew: [archivedBlock], send: [ok()] } });
    const r = await runCase(eff('R12-default-locked-admin-public-archived'), ports, ctx);
    expect(r.status).toBe('ok');
    expect(attempts).toEqual(['view', 'readHistory', 'reactExisting', 'reactNew', 'send']);
    expect(r.observed.view?.archivedAfter).toBe(true);
    expect(r.observed.reactExisting).toMatchObject({ result: 'blocked_archived', archivedAfter: true });
    expect(r.observed.reactNew).toMatchObject({ result: 'blocked_archived', archivedAfter: true });
    expect(r.observed.send).toMatchObject({ result: 'allowed', archivedAfter: false });
    expect(r.effective.AddReactions).toBe('unobservable');
  });

  it('a locked staffer\'s denied send leaves the archived thread archived', async () => {
    const { ports } = fakePorts({ act: { reactExisting: [archivedBlock], reactNew: [archivedBlock], send: [denied] } });
    const r = await runCase(eff('R12-default-locked-staffer-public-archived'), ports, ctx);
    expect(r.observed.send).toMatchObject({ result: 'denied', archivedAfter: true });
  });

  it('channel cases carry no archivedAfter', async () => {
    const { ports } = fakePorts();
    const r = await runCase(eff('R2-default-open-staffer'), ports, ctx);
    expect(r.observed.send).not.toHaveProperty('archivedAfter');
  });

  it('is arrange_failed when the locked write is refused, and observes nothing', async () => {
    const { ports, attempts } = fakePorts({ refuseWrite: 2 });
    const r = await runCase(eff('R4-default-locked-staffer'), ports, ctx);
    expect(r.status).toBe('arrange_failed');
    expect(r.failure).toMatch(/write 2/);
    expect(attempts).toEqual([]);
  });

  it('is arrange_failed when Discord stores something other than what genie wrote', async () => {
    const { ports } = fakePorts({ storeDifferently: (w) => w.map((o) => ({ ...o, allow: o.allow.filter((p) => p !== 'ManageChannels') })) });
    const r = await runCase(eff('R2-default-open-staffer'), ports, ctx);
    expect(r.status).toBe('arrange_failed');
    expect(r.failure).toMatch(/read-back/);
  });

  it('R8: genie writes nothing and the channel\'s overwrites are read back after the create', async () => {
    const { ports, overwrites } = fakePorts({ refuseWrite: 1 });
    const r = await runCase(eff('R8-default-category-staffer'), ports, ctx);
    expect(r.status).toBe('ok');
    expect(r.channelOverwrites.find((o) => o.target === 'everyone')?.deny).toEqual(['ViewChannel']);
    expect(r.categoryOverwrites).not.toBeNull();
    expect([...overwrites.values()].length).toBeGreaterThan(0);
  });

  it('records the library view beside the observation without using it', async () => {
    const { ports } = fakePorts({ library: { SendMessages: true }, act: { send: [denied] } });
    const r = await runCase(eff('R4-default-locked-staffer'), ports, ctx);
    expect(r.computedByLibrary.SendMessages).toBe(true);
    expect(r.effective.SendMessages).toBe(false);
  });

  it('stores channel overwrites symbolically, with no snowflakes', async () => {
    const { ports } = fakePorts();
    const r = await runCase(eff('R4-default-locked-staffer'), ports, ctx);
    expect(JSON.stringify(r)).not.toMatch(/\b\d{17,20}\b/);
  });
});

describe('runWriteCase', () => {
  it('records a refusal with its code and context', async () => {
    const { ports } = fakePorts({ refuseEditFor: () => true });
    const r = await runWriteCase(wc('W2-nosend-lock'), ports, ctx);
    expect(r).toMatchObject({ caseId: 'W2-nosend-lock', result: 'refused', status: 403, code: 50013 });
    expect(r.stored).toBeUndefined();
  });

  it('records what Discord stored, not what was attempted', async () => {
    const { ports } = fakePorts({ storeDifferently: (w) => w.slice(1) });
    const r = await runWriteCase(wc('W1-default-sync'), ports, ctx);
    expect(r.result).toBe('ok');
    expect(r.stored).toHaveLength(wc('W1-default-sync').attempted.length - 1);
  });

  it('creates W6 at the top level and W0\'s channel under a parent category', async () => {
    const f = fakePorts();
    await runWriteCase(wc('W6-default-mrself'), f.ports, ctx);
    await runWriteCase(wc('W0-default-create'), f.ports, ctx);
    const [w6, w0] = f.creates;
    expect(w6).toMatchObject({ kind: 'channel' });
    expect(w6!.parentId).toBeUndefined();
    expect(w0!.parentId).toBeDefined();
  });

  it('creates through the create path', async () => {
    const { ports } = fakePorts({ createOutcome: (k) => (k === 'channel' ? { kind: 'http', status: 403, code: 50013 } : ok(201)) });
    expect((await runWriteCase(wc('W0-default-createcategory'), ports, ctx)).result).toBe('ok');
    expect((await runWriteCase(wc('W0-default-create'), ports, ctx)).result).toBe('refused');
  });
});

describe('runPass', () => {
  const catalog = buildCatalog();

  it('runs every case and tears each one down', async () => {
    const f = fakePorts();
    const pass = await runPass(catalog, f.ports, ctx, 'p1');
    expect(pass.stop).toBeUndefined();
    expect(pass.writes).toHaveLength(19);
    expect(pass.cases).toHaveLength(catalog.length - 19);
    expect(f.teardowns()).toBe(catalog.length);
  });

  it('stops before the effective cases when an edit-path production case is refused', async () => {
    const f = fakePorts({ refuseEditFor: (name) => name.includes('w1-default-sync') });
    const pass = await runPass(catalog, f.ports, ctx, 'p1');
    expect(pass.stop).toEqual({ reason: 'profile_unwritable', caseIds: ['W1-default-sync'] });
    expect(pass.cases).toEqual([]);
  });

  it('stops when an accepted production write is stored differently', async () => {
    const f = fakePorts({
      storeDifferently: (w) => w.map((o) => ({ ...o, allow: o.allow.filter((p) => p !== 'ManageChannels') })),
    });
    const pass = await runPass(catalog, f.ports, ctx, 'p1');
    expect(pass.stop?.reason).toBe('profile_unwritable');
  });

  it('continues when only the create path is refused and the fallback works, flagging the amendment', async () => {
    const f = fakePorts({ createOutcome: (_k, name) => (/-w0-/.test(name) ? { kind: 'http', status: 403, code: 50013 } : ok(201)) });
    const pass = await runPass(catalog, f.ports, ctx, 'p1');
    expect(pass.stop).toBeUndefined();
    expect(pass.amendmentRequired.sort()).toEqual(
      ['W0-default-create', 'W0-default-createcategory', 'W0-nosend-create', 'W0-nosend-createcategory'].sort(),
    );
    expect(pass.cases.length).toBeGreaterThan(0);
  });

  it('stops when the create path and the fallback are both unwritable', async () => {
    const f = fakePorts({
      createOutcome: (_k, name) => (/-w0-/.test(name) ? { kind: 'http', status: 403, code: 50013 } : ok(201)),
      refuseEditFor: (name) => name.includes('w1-nosend-fallback'),
    });
    const pass = await runPass(catalog, f.ports, ctx, 'p1');
    expect(pass.stop?.caseIds.sort()).toEqual(['W0-nosend-create', 'W0-nosend-createcategory', 'W1-nosend-fallback'].sort());
  });

  it('records a non-production refusal as data and carries on', async () => {
    const f = fakePorts({ refuseEditFor: (name) => name.includes('w4-default-edit') });
    const pass = await runPass(catalog, f.ports, ctx, 'p1');
    expect(pass.stop).toBeUndefined();
    expect(pass.writes.find((w) => w.caseId === 'W4-default-edit')?.result).toBe('refused');
  });

  it('never stops on the diagnostic cases, even when every one of them is refused', async () => {
    const f = fakePorts({
      createOutcome: (_k, name) => (/-w6-/.test(name) ? { kind: 'http', status: 403, code: 50013 } : ok(201)),
      refuseEditFor: (name) => /-w[57]-/.test(name),
    });
    const pass = await runPass(catalog, f.ports, ctx, 'p1');
    expect(pass.stop).toBeUndefined();
    expect(pass.amendmentRequired).toEqual([]);
    const diagnostic = pass.writes.filter((w) => /^W[5-7]-/.test(w.caseId));
    expect(diagnostic).toHaveLength(7);
    expect(diagnostic.every((w) => w.result === 'refused' && w.code === 50013)).toBe(true);
    expect(pass.cases.length).toBeGreaterThan(0);
  });

  it('keeps the diagnostic records in a pass that stops', async () => {
    const f = fakePorts({ refuseEditFor: (name) => name.includes('w2-default-lock') || /-w[57]-/.test(name) });
    const pass = await runPass(catalog, f.ports, ctx, 'p1');
    expect(pass.stop).toEqual({ reason: 'profile_unwritable', caseIds: ['W2-default-lock'] });
    expect(pass.writes.filter((w) => /^W[5-7]-/.test(w.caseId) && w.result === 'refused')).toHaveLength(2);
    expect(pass.writes).toHaveLength(19);
  });
});
