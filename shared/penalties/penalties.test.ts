import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AccessPlan, Principal } from '../access/access';
import { type CatalogRow, type CsvPenalty, EDIT_WINDOW_MS, catalogOptions, editRight, penaltiesCsv } from './index';

const row = (id: number, label: string, over: Partial<CatalogRow> = {}): CatalogRow => ({
  id,
  season: '2026-27',
  label,
  games: ['tcg', 'vgc', 'go', 'other'],
  rank: id,
  active: true,
  ...over,
});

describe('catalogOptions', () => {
  const catalog = {
    categories: [row(1, 'Game Play'), row(2, 'Deck/Team'), row(3, 'Pace of Play'), row(4, 'Procedural'), row(5, 'Unsporting'), row(6, 'Cheating'), row(7, 'VGC only', { games: ['vgc'], rank: 0 })],
    types: [
      row(11, 'Warning', { rank: 0 }),
      row(12, 'DPC', { games: ['tcg'], rank: 1 }),
      row(13, 'QPC', { games: ['tcg'], rank: 2 }),
      row(14, 'GL', { rank: 3, active: false }),
      row(15, 'DQ', { rank: 4 }),
      row(16, 'Old season', { season: '2025-26' }),
    ],
  };

  it('offers the active rows of the season that apply to the game, by rank then id', () => {
    const tcg = catalogOptions(catalog, '2026-27', 'tcg');
    expect(tcg.categories.map((c) => c.label)).toEqual(['Game Play', 'Deck/Team', 'Pace of Play', 'Procedural', 'Unsporting', 'Cheating']);
    expect(tcg.types.map((t) => t.label)).toEqual(['Warning', 'DPC', 'QPC', 'DQ']);
    const vgc = catalogOptions(catalog, '2026-27', 'vgc');
    expect(vgc.categories.map((c) => c.label)).toEqual(['VGC only', 'Game Play', 'Deck/Team', 'Pace of Play', 'Procedural', 'Unsporting', 'Cheating']);
    expect(vgc.types.map((t) => t.label)).toEqual(['Warning', 'DQ']);
  });

  it('breaks rank ties by id and offers nothing for an unknown season', () => {
    const tied = { categories: [row(9, 'B', { rank: 1 }), row(8, 'A', { rank: 1 })], types: [] };
    expect(catalogOptions(tied, '2026-27', 'go').categories.map((c) => c.id)).toEqual([8, 9]);
    expect(catalogOptions(catalog, '1999-00', 'tcg')).toEqual({ categories: [], types: [] });
  });
});

describe('editRight', () => {
  const EVENT = 5;
  const JUDGE = '100000000000000051';
  const HJ = '100000000000000052';
  const OTHER_HJ = '100000000000000053';
  const plan: AccessPlan = {
    dayId: 1,
    staff: [
      { discordUserId: JUDGE, headJudgeOf: [], staffOf: [EVENT] },
      { discordUserId: HJ, headJudgeOf: [EVENT], staffOf: [EVENT] },
      { discordUserId: OTHER_HJ, headJudgeOf: [6], staffOf: [6] },
    ],
    channels: [],
  };
  const t = 1_000_000;
  const penalty = { eventId: EVENT, judgeDiscordUserId: JUDGE, recordedAt: t };
  const as = (userId: string): Principal => ({ userId, grant: 'event_head_judge', holdsHeadJudgeRole: false });

  it('gives the recording judge an edit window of exactly 15 minutes, inclusive', () => {
    expect(EDIT_WINDOW_MS).toBe(15 * 60_000);
    expect(editRight(penalty, as(JUDGE), plan, t)).toBe('judge_window');
    expect(editRight(penalty, as(JUDGE), plan, t + EDIT_WINDOW_MS)).toBe('judge_window');
    expect(editRight(penalty, as(JUDGE), plan, t + EDIT_WINDOW_MS + 1)).toBeNull();
  });

  it('closes the window once the judge leaves the event', () => {
    const removed: AccessPlan = { ...plan, staff: plan.staff.filter((s) => s.discordUserId !== JUDGE) };
    expect(editRight(penalty, as(JUDGE), removed, t + 1)).toBeNull();
  });

  it('lets the event head judge and organizers manage at any time, and nobody else', () => {
    expect(editRight(penalty, as(HJ), plan, t + 10 * EDIT_WINDOW_MS)).toBe('manage');
    expect(editRight(penalty, { userId: OTHER_HJ, grant: 'organizer_role', holdsHeadJudgeRole: false }, plan, t + 10 * EDIT_WINDOW_MS)).toBe('manage');
    expect(editRight(penalty, as(OTHER_HJ), plan, t)).toBeNull();
    expect(editRight(penalty, null, plan, t)).toBeNull();
  });

  it('gives no window for a penalty whose judge has no Discord account', () => {
    expect(editRight({ ...penalty, judgeDiscordUserId: null }, as(JUDGE), plan, t)).toBeNull();
  });
});

describe('penaltiesCsv', () => {
  const base = { judgePlayerId: '123456', severity: 'Minor' as const };
  // Out of order on purpose: the writer sorts by round, then recording time, then number.
  const penalties: CsvPenalty[] = [
    { ...base, number: 2, round: 6, recordedAt: 2000, competitorPlayerId: '7654321', category: 'Deck/Team', severity: 'Major', penaltyType: 'GL', notes: 'Marked cards with pattern, "sleeves"\nGame Loss issued for Round 1 of Top Cut.' },
    { ...base, number: 5, round: 2, recordedAt: 4000, competitorPlayerId: '98', category: 'Pace of Play', penaltyType: 'Warning', notes: '+1 slow play' },
    { ...base, number: 4, round: 2, recordedAt: 4000, competitorPlayerId: '99', category: 'Unsporting', severity: 'Severe', penaltyType: 'DQ', notes: '=SUM(A1:A2)' },
    { ...base, number: 3, round: 1, recordedAt: 3000, judgePlayerId: '654321', competitorPlayerId: '42', category: 'Procedural', penaltyType: 'DPC', notes: '' },
    { ...base, number: 1, round: 1, recordedAt: 1000, competitorPlayerId: '0001234', category: 'Game Play', penaltyType: 'Warning', notes: 'Played Buddy-Buddy Poffin and did not get out a Pokémon' },
  ];

  it('writes the golden file byte for byte', () => {
    const golden = readFileSync(new URL('../../test/fixtures/penalties/golden.csv', import.meta.url));
    const out = Buffer.from(penaltiesCsv('26-10-000123', penalties), 'utf8');
    expect(out.equals(golden)).toBe(true);
    expect(out.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(out.toString('utf8')).not.toContain('\r');
  });

  it('writes the header only for an event without penalties', () => {
    expect(penaltiesCsv('26-10-000123', [])).toBe("Tournament ID,Round of Issue,Judge Player ID,Competitor's Player ID,Category,Severity,Penalty,Notes\n");
  });

  it('quotes a field holding a carriage return or a comma in a label, and nothing else', () => {
    const out = penaltiesCsv('26-10-000123', [{ ...base, number: 1, round: 1, recordedAt: 1, competitorPlayerId: '1', category: 'A, B', penaltyType: 'W', notes: 'line\rbreak' }]);
    expect(out.split('\n')[1]).toBe('26-10-000123,1,123456,1,"A, B",Minor,W,"line\rbreak"');
  });
});
