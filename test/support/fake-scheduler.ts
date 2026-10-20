import type { FakeClock } from '@towerism/selfhost-kit/testing';
import type { DelayScheduler } from '../../server/modules/message-delivery';

export interface FakeScheduler extends DelayScheduler {
  /** The delays of the timers still waiting, soonest first. */
  pending(): number[];
  /** Resolves with a timer's delay once one is waiting (at once if one already is). */
  nextTimer(): Promise<number>;
  /** Moves the clock to the soonest timer's due time (never backwards) and runs it. */
  fireNext(): void;
}

/** Timers that run only when a test fires them, on a fake clock, so no test waits on real time. */
export function fakeScheduler(clock: FakeClock): FakeScheduler {
  let seq = 0;
  const timers: { id: number; ms: number; dueAt: number; fn: () => void }[] = [];
  let waiters: Array<(ms: number) => void> = [];
  const soonest = () => [...timers].sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
  return {
    after(ms, fn) {
      const timer = { id: ++seq, ms, dueAt: clock.now() + ms, fn };
      timers.push(timer);
      const ready = waiters;
      waiters = [];
      for (const resolve of ready) resolve(ms);
      return () => {
        const at = timers.indexOf(timer);
        if (at >= 0) timers.splice(at, 1);
      };
    },
    pending: () => soonest().map((t) => t.ms),
    nextTimer: () => (timers.length ? Promise.resolve(soonest()[0]!.ms) : new Promise((resolve) => waiters.push(resolve))),
    fireNext() {
      const timer = soonest()[0];
      if (!timer) throw new Error('No timer is waiting.');
      timers.splice(timers.indexOf(timer), 1);
      if (timer.dueAt > clock.now()) clock.set(timer.dueAt);
      timer.fn();
    },
  };
}
