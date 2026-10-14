import { describe, expect, it } from 'vitest';
import { snowflakeMs } from '../../src/shared/ids.js';
import { RunTracker, s2Duration, summarize, type S2Run } from '../../src/s2/timing.js';

/** A snowflake `ms` milliseconds after the base one. */
const at = (ms: number) => (1300000000000000000n + (BigInt(ms) << 22n)).toString();
const user = '1300000000000000111';
const device = 'pixel-8';

describe('s2Duration', () => {
  it('is the difference of the two snowflake timestamps', () => {
    expect(s2Duration('1300000000000000000', '1300000050331648000')).toEqual({ ms: 12000 });
  });

  it('refuses a submit earlier than the start', () => {
    expect(s2Duration('1300000050331648000', '1300000000000000000')).toEqual({ error: 'clock_inversion' });
  });
});

describe('RunTracker', () => {
  it('times a run from the Start button to the modal submit, with the modal time as secondary', () => {
    const t = new RunTracker(device);
    t.start({ variant: 'A', userId: user, id: at(0) });
    t.command({ variant: 'A', userId: user, id: at(9000) });
    const run = t.submit({ variant: 'A', userId: user, id: at(20000), outcome: 'ok' });
    expect(run).toEqual({
      variant: 'A',
      device,
      startId: at(0),
      commandId: at(9000),
      submitId: at(20000),
      durationMs: 20000,
      modalMs: 11000,
      outcome: 'ok',
    });
  });

  it('records the first run abandoned when a second Start for the same variant arrives', () => {
    const t = new RunTracker(device);
    t.start({ variant: 'B', userId: user, id: at(0) });
    const abandoned = t.start({ variant: 'B', userId: user, id: at(5000) });
    expect(abandoned).toMatchObject({ variant: 'B', startId: at(0), outcome: 'abandoned' });
    const run = t.submit({ variant: 'B', userId: user, id: at(12000), outcome: 'ok' });
    expect(run).toMatchObject({ startId: at(5000), durationMs: 7000 });
  });

  it('keeps runs of different variants and users apart', () => {
    const t = new RunTracker(device);
    t.start({ variant: 'A', userId: user, id: at(0) });
    t.start({ variant: 'B', userId: user, id: at(1000) });
    expect(t.submit({ variant: 'B', userId: user, id: at(4000), outcome: 'ok' })?.durationMs).toBe(3000);
    expect(t.submit({ variant: 'A', userId: 'someone-else', id: at(4000), outcome: 'ok' })).toBeUndefined();
  });

  it('records a run with no submit within 10 minutes as abandoned', () => {
    const t = new RunTracker(device);
    t.start({ variant: 'A', userId: user, id: at(0) });
    expect(t.expire(snowflakeMs(at(0)) + 9 * 60_000)).toEqual([]);
    expect(t.expire(snowflakeMs(at(0)) + 10 * 60_000 + 1)).toEqual([expect.objectContaining({ outcome: 'abandoned' })]);
    expect(t.submit({ variant: 'A', userId: user, id: at(11 * 60_000), outcome: 'ok' })).toBeUndefined();
  });

  it('records open runs as abandoned when the bot exits', () => {
    const t = new RunTracker(device);
    t.start({ variant: 'A', userId: user, id: at(0) });
    t.start({ variant: 'B', userId: user, id: at(0) });
    expect(t.close().map((r) => r.variant).sort()).toEqual(['A', 'B']);
  });

  it('records an invalid submission as an error outcome with its duration', () => {
    const t = new RunTracker(device);
    t.start({ variant: 'A', userId: user, id: at(0) });
    expect(t.submit({ variant: 'A', userId: user, id: at(3000), outcome: 'invalid_player_id' })).toMatchObject({
      outcome: 'invalid_player_id',
      durationMs: 3000,
    });
  });
});

describe('summarize', () => {
  const run = (variant: 'A' | 'B', outcome: S2Run['outcome'], durationMs?: number): S2Run => ({
    variant,
    device,
    startId: '1',
    outcome,
    ...(durationMs !== undefined ? { durationMs } : {}),
  });

  it('counts runs and errors and takes the median and max of successful runs', () => {
    const runs = [
      run('A', 'ok', 10000),
      run('A', 'ok', 20000),
      run('A', 'ok', 30000),
      run('A', 'error'),
      run('B', 'ok', 12000),
      run('B', 'ok', 14000),
    ];
    expect(summarize(runs)).toEqual([
      { variant: 'A', device, runs: 4, errors: 1, abandoned: 0, medianMs: 20000, maxMs: 30000 },
      { variant: 'B', device, runs: 2, errors: 0, abandoned: 0, medianMs: 13000, maxMs: 14000 },
    ]);
  });

  it('counts abandoned runs on their own, leaving runs, errors, median and max unchanged', () => {
    const base = [run('A', 'ok', 10000), run('A', 'ok', 20000), run('A', 'ok', 30000), run('A', 'error')];
    const [a] = summarize([...base, run('A', 'abandoned')]);
    expect(a).toEqual({ variant: 'A', device, runs: 4, errors: 1, abandoned: 1, medianMs: 20000, maxMs: 30000 });
  });

  it('counts client_unsupported and invalid_player_id as errors', () => {
    const [b] = summarize([run('B', 'ok', 1000), run('B', 'client_unsupported'), run('B', 'invalid_player_id', 900)]);
    expect(b).toMatchObject({ runs: 3, errors: 2, medianMs: 1000 });
  });

  it('reports no median for a group with no successful runs', () => {
    expect(summarize([run('A', 'error')])[0]).toMatchObject({ medianMs: null, maxMs: null });
  });
});
