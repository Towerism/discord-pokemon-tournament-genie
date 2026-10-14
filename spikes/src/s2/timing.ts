import { snowflakeMs } from '../shared/ids.js';
import type { Variant } from './forms.js';

export type S2Outcome = 'ok' | 'invalid_player_id' | 'client_unsupported' | 'abandoned' | 'error';

/** One line of `spikes/out/s2-runs.jsonl`. Times come from Discord's snowflakes, never the harness clock. */
export type S2Run = {
  variant: Variant;
  device: string;
  startId: string;
  commandId?: string;
  submitId?: string;
  durationMs?: number;
  modalMs?: number;
  outcome: S2Outcome;
  note?: string;
};

export const ABANDON_AFTER_MS = 10 * 60_000;

export function s2Duration(startId: string, submitId: string): { ms: number } | { error: 'clock_inversion' } {
  const ms = snowflakeMs(submitId) - snowflakeMs(startId);
  return ms < 0 ? { error: 'clock_inversion' } : { ms };
}

type Event = { variant: Variant; userId: string; id: string };
type Open = { startId: string; commandId?: string };

/** Pairs each judge's Start press with their next submit of the same variant (FR-13). */
export class RunTracker {
  private readonly open = new Map<string, Open>();

  constructor(private readonly device: string) {}

  private key(e: { variant: Variant; userId: string }) {
    return `${e.userId}:${e.variant}`;
  }

  private abandoned(variant: Variant, o: Open): S2Run {
    return { variant, device: this.device, startId: o.startId, ...(o.commandId ? { commandId: o.commandId } : {}), outcome: 'abandoned' };
  }

  /** Starts a run; returns the run it replaced, recorded as abandoned. */
  start(e: Event): S2Run | undefined {
    const previous = this.open.get(this.key(e));
    this.open.set(this.key(e), { startId: e.id });
    return previous ? this.abandoned(e.variant, previous) : undefined;
  }

  command(e: Event): void {
    const o = this.open.get(this.key(e));
    if (o) o.commandId = e.id;
  }

  submit(e: Event & { outcome: Exclude<S2Outcome, 'abandoned'> }): S2Run | undefined {
    const o = this.open.get(this.key(e));
    if (!o) return undefined;
    this.open.delete(this.key(e));
    const d = s2Duration(o.startId, e.id);
    const run: S2Run = {
      variant: e.variant,
      device: this.device,
      startId: o.startId,
      ...(o.commandId ? { commandId: o.commandId } : {}),
      submitId: e.id,
      outcome: 'ms' in d ? e.outcome : 'error',
      ...('ms' in d ? { durationMs: d.ms } : { note: 'clock_inversion' }),
    };
    if (o.commandId && 'ms' in d) {
      const m = s2Duration(o.commandId, e.id);
      if ('ms' in m) run.modalMs = m.ms;
    }
    return run;
  }

  /** Abandons runs older than 10 minutes at `nowMs` (the bot's clock, used only for this cut-off). */
  expire(nowMs: number): S2Run[] {
    const out: S2Run[] = [];
    for (const [key, o] of this.open) {
      if (nowMs - snowflakeMs(o.startId) > ABANDON_AFTER_MS) {
        this.open.delete(key);
        out.push(this.abandoned(key.endsWith(':A') ? 'A' : 'B', o));
      }
    }
    return out;
  }

  /** At bot exit, every open run is abandoned. */
  close(): S2Run[] {
    const out = [...this.open].map(([key, o]) => this.abandoned(key.endsWith(':A') ? 'A' : 'B', o));
    this.open.clear();
    return out;
  }
}

export type S2Summary = {
  variant: Variant;
  device: string;
  runs: number;
  errors: number;
  abandoned: number;
  medianMs: number | null;
  maxMs: number | null;
};

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Per variant and device. Errors are every outcome except `ok` and `abandoned`. */
export function summarize(runs: S2Run[]): S2Summary[] {
  const groups = new Map<string, S2Run[]>();
  for (const r of runs) {
    const k = `${r.variant}\u0000${r.device}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, rs]) => {
      const counted = rs.filter((r) => r.outcome !== 'abandoned');
      const ok = counted.filter((r) => r.outcome === 'ok' && r.durationMs !== undefined).map((r) => r.durationMs!);
      return {
        variant: rs[0]!.variant,
        device: rs[0]!.device,
        runs: counted.length,
        errors: counted.filter((r) => r.outcome !== 'ok').length,
        abandoned: rs.length - counted.length,
        medianMs: median(ok),
        maxMs: ok.length ? Math.max(...ok) : null,
      };
    });
}
