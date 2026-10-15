import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BLUEPRINT } from '../../../shared/blueprints';
import type { CatalogRow } from '../../../shared/penalties';
import { PEOPLE } from '../../../test/support/provisioning-world';
import { type PenaltyWorld, penaltyWorld } from '../../../test/support/penalty-world';
import { ServiceError } from '../errors';
import type { CatalogRowInput } from './index';

let w: PenaltyWorld;
afterEach(() => w?.close());

const count = (table: string) => w.database.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).pluck().get();
const refusal = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (err) {
    if (err instanceof ServiceError) return { status: err.status, code: err.code, data: err.data };
    throw err;
  }
  throw new Error('expected a refusal');
};

describe('recording a penalty', () => {
  it('records once per key: a repeat answers the same row, another recorder or event a conflict without data', async () => {
    w = await penaltyWorld();
    const input = w.recordInput({ key: 'discord:111' });
    const first = await w.penalties.record(input);
    expect(first.created).toBe(true);
    expect(first.penalty).toMatchObject({ number: 1, revision: 1, round: 3, competitorPlayerId: '0012345', judge: { staffMemberId: w.people.ash.id, playerId: '00123' }, state: 'active' });
    expect(first.penalty.revisions).toEqual([expect.objectContaining({ revision: 1, action: 'recorded', editedBy: PEOPLE.ash })]);

    const again = await w.penalties.record(input);
    expect(again).toMatchObject({ created: false, penalty: { id: first.penalty.id, number: 1 } });
    expect(count('penalty')).toBe(1);
    expect(count('penalty_revision')).toBe(1);

    const other = await refusal(w.penalties.record({ ...input, recordedBy: PEOPLE.brock }));
    expect(other).toEqual({ status: 409, code: 'idempotency_conflict', data: {} });
    expect(await refusal(w.penalties.record({ ...input, eventId: w.vgc.id }))).toMatchObject({ code: 'idempotency_conflict', data: {} });
  });

  it('answers a replay with the recorded row even after the judge left the event', async () => {
    w = await penaltyWorld();
    const input = w.recordInput({ key: 'discord:222' });
    const first = await w.penalties.record(input);
    w.days.putStaff(w.dayId, [{ staffMemberId: w.people.brock.id, events: [{ eventId: w.tcg.id, role: 'headjudge' }] }]);
    expect(await w.penalties.record(input)).toMatchObject({ created: false, penalty: { id: first.penalty.id } });
  });

  it('answers a key that lands between the lookup and the insert as a key hit, through the unique index', async () => {
    let racer: (() => void) | null = null;
    w = await penaltyWorld({ beforeInsert: () => racer?.() });
    const input = w.recordInput({ key: 'web:race' });
    racer = () => {
      racer = null;
      // Another process's insert, between this one's lookup and insert.
      w.database.sqlite
        .prepare(
          `INSERT INTO penalty (event_id, number, idempotency_key, round, competitor_player_id, category_id, severity, penalty_type_id, judge_staff_id, judge_player_id, recorded_by, recorded_at, revision, card_state)
           VALUES (?, 1, 'web:race', 3, '0012345', ?, 'Minor', ?, ?, '00123', ?, 1, 1, 'none')`,
        )
        .run(w.tcg.id, input.categoryId, input.penaltyTypeId, w.people.ash.id, PEOPLE.ash);
    };
    const result = await w.penalties.record(input);
    expect(result.created).toBe(false);
    expect(count('penalty')).toBe(1);
  });

  it('numbers penalties per event and never reuses a number', async () => {
    w = await penaltyWorld();
    await w.penalties.record(w.recordInput());
    const second = await w.penalties.record(w.recordInput());
    const vgc = await w.penalties.record(w.recordInput({ eventId: w.vgc.id, judgeStaffMemberId: w.people.misty.id, recordedBy: PEOPLE.misty }));
    expect(second.penalty.number).toBe(2);
    expect(vgc.penalty.number).toBe(1);
  });

  it('refuses every invalid input and inserts nothing', async () => {
    w = await penaltyWorld();
    const cases: [Parameters<PenaltyWorld['recordInput']>[0], { code: string; data?: object }][] = [
      [{ round: 0 }, { code: 'invalid_field', data: { field: 'round' } }],
      [{ round: 100 }, { code: 'invalid_field', data: { field: 'round' } }],
      [{ round: 2.5 }, { code: 'invalid_field', data: { field: 'round' } }],
      [{ competitorPlayerId: '12a' }, { code: 'invalid_field', data: { field: 'competitorPlayerId' } }],
      [{ competitorPlayerId: '12345678901' }, { code: 'invalid_field', data: { field: 'competitorPlayerId' } }],
      [{ penaltyTypeId: 0 }, { code: 'invalid_catalog_choice', data: { field: 'penaltyTypeId' } }],
      [{ notes: 'x'.repeat(1001) }, { code: 'invalid_field', data: { field: 'notes' } }],
      [{ severity: 'Huge' as never }, { code: 'invalid_field', data: { field: 'severity' } }],
      [{ judgeStaffMemberId: w.people.misty.id }, { code: 'judge_not_on_event' }],
      [{ judgeStaffMemberId: w.people.dawn.id }, { code: 'judge_without_player_id' }],
      [{ eventId: 999_999 }, { code: 'not_found' }],
    ];
    for (const [over, expected] of cases) expect(await refusal(w.penalties.record(w.recordInput(over)))).toMatchObject(expected);
    // DPC is TCG only.
    expect(await refusal(w.penalties.record(w.recordInput({ eventId: w.vgc.id, judgeStaffMemberId: w.people.misty.id, penaltyTypeId: w.typeId('DPC') })))).toMatchObject({
      code: 'invalid_catalog_choice',
      data: { field: 'penaltyTypeId' },
    });
    expect(count('penalty')).toBe(0);

    const kept = await w.penalties.record(w.recordInput({ competitorPlayerId: '0012345', notes: '  padded  ' }));
    expect(kept.penalty).toMatchObject({ competitorPlayerId: '0012345', notes: 'padded' });
  });

  it('refuses a deactivated row, another season’s row, and a day that isn’t open', async () => {
    w = await penaltyWorld();
    w.database.sqlite.prepare(`UPDATE penalty_category SET active = 0 WHERE id = ?`).run(w.categoryId('Cheating'));
    expect(await refusal(w.penalties.record(w.recordInput({ categoryId: w.categoryId('Cheating') })))).toMatchObject({ code: 'invalid_catalog_choice', data: { field: 'categoryId' } });
    w.penalties.setSeason('2027-28', '2026-27');
    expect(await refusal(w.penalties.record(w.recordInput({ categoryId: w.categoryId('Game Play', '2027-28') })))).toMatchObject({ code: 'invalid_catalog_choice' });
    const { day } = w.days.createDay({ date: '2026-10-18', title: 'Draft' });
    const draftEvent = w.days.addEvent(day.id, { name: 'Draft cup', game: 'tcg', startTime: '10:00' });
    expect(await refusal(w.penalties.record(w.recordInput({ dayId: day.id, eventId: draftEvent.id })))).toMatchObject({ status: 409, code: 'day_not_open' });
    expect(count('penalty')).toBe(0);
  });
});

describe('the card', () => {
  it('posts an embed in the event’s penalties channel that pings nobody, with Edit and Void', async () => {
    w = await penaltyWorld();
    const { penalty } = await w.penalties.record(w.recordInput({ notes: '@everyone see <@123>' }));
    const [card, ...more] = w.messagesIn('cup-penalties');
    expect(more).toEqual([]);
    expect(card!.embed).toEqual({
      title: 'Penalty #1 · Round 3',
      fields: [
        { name: "Competitor's player ID", value: '0012345' },
        { name: 'Category', value: 'Game Play' },
        { name: 'Severity', value: 'Minor' },
        { name: 'Penalty', value: 'Warning' },
        { name: 'Judge', value: 'Ash (00123)' },
        { name: 'Notes', value: '@everyone see <@123>' },
      ],
      footer: 'Cup',
    });
    expect(card!.buttons).toEqual([
      { customId: `genie:penalty-edit:${penalty.id}`, label: 'Edit' },
      { customId: `genie:penalty-void:${penalty.id}`, label: 'Void', style: 'danger' },
    ]);
    expect(w.penalties.get(penalty.id)).toMatchObject({ cardState: 'posted' });
  });

  it('keeps the penalty when Discord fails, and records the card as failed', async () => {
    w = await penaltyWorld();
    w.discord.failNext('unavailable');
    const result = await w.penalties.record(w.recordInput());
    expect(result.penalty.cardState).toBe('failed');
    expect(count('penalty')).toBe(1);
  });

  it('falls back to the event’s other channel, and never posts in a day-wide channel', async () => {
    w = await penaltyWorld({ blueprint: { ...DEFAULT_BLUEPRINT, name: 'No penalties channel', channels: DEFAULT_BLUEPRINT.channels.filter((c) => c.key !== 'penalties') } });
    await w.penalties.record(w.recordInput());
    expect(w.messagesIn('cup-floor')).toHaveLength(1);
    w.close();

    w = await penaltyWorld({ blueprint: { ...DEFAULT_BLUEPRINT, name: 'Day-wide only', channels: DEFAULT_BLUEPRINT.channels.filter((c) => c.scope === 'day') } });
    const before = w.discord.messages.size;
    const result = await w.penalties.record(w.recordInput());
    expect(result.penalty.cardState).toBe('none');
    expect(w.discord.messages.size).toBe(before);
  });

  it('edits the card to the latest revision even when the first card edit is held', async () => {
    w = await penaltyWorld();
    const { penalty } = await w.penalties.record(w.recordInput());
    let release!: () => void;
    w.discord.writeGate = new Promise((r) => (release = r));
    const first = w.penalties.edit(w.dayId, penalty.id, { severity: 'Major' }, { expectedRevision: 1, by: PEOPLE.brock });
    const second = w.penalties.edit(w.dayId, penalty.id, { severity: 'Severe' }, { expectedRevision: 2, by: PEOPLE.brock });
    release();
    await Promise.all([first, second]);
    w.discord.writeGate = null;
    const [card] = w.messagesIn('cup-penalties');
    expect(card!.embed!.fields.find((f) => f.name === 'Severity')?.value).toBe('Severe');
    expect(card!.embed!.footer).toBe('Cup · Edited by Brock · revision 3');
  });

  it('names an editor the directory doesn’t know as an organizer, and leaves out empty notes', async () => {
    w = await penaltyWorld();
    const { penalty } = await w.penalties.record(w.recordInput({ notes: '' }));
    await w.penalties.edit(w.dayId, penalty.id, { severity: 'Major' }, { expectedRevision: 1, by: PEOPLE.organizer });
    const [card] = w.messagesIn('cup-penalties');
    expect(card!.embed!.footer).toBe('Cup · Edited by an organizer · revision 2');
    expect(card!.embed!.fields.map((f) => f.name)).not.toContain('Notes');
  });

  it('records a deleted card as missing, and reposts it', async () => {
    w = await penaltyWorld();
    const { penalty } = await w.penalties.record(w.recordInput());
    const [card] = w.messagesIn('cup-penalties');
    w.discord.messages.delete(card!.id);
    await w.penalties.edit(w.dayId, penalty.id, { notes: 'more' }, { expectedRevision: 1, by: PEOPLE.brock });
    expect(w.penalties.get(penalty.id)!.cardState).toBe('missing');

    const reposted = await w.penalties.repost(w.dayId, penalty.id);
    expect(reposted.cardState).toBe('posted');
    expect(w.messagesIn('cup-penalties')).toHaveLength(1);
  });

  it('reposts over a live card, removing the old one', async () => {
    w = await penaltyWorld();
    const { penalty } = await w.penalties.record(w.recordInput());
    const [old] = w.messagesIn('cup-penalties');
    await w.penalties.repost(w.dayId, penalty.id);
    const now = w.messagesIn('cup-penalties');
    expect(now).toHaveLength(1);
    expect(now[0]!.id).not.toBe(old!.id);
  });

  it('refuses a repost without a card channel, and keeps the stored card when Discord fails', async () => {
    w = await penaltyWorld({ blueprint: { ...DEFAULT_BLUEPRINT, name: 'Day-wide only', channels: DEFAULT_BLUEPRINT.channels.filter((c) => c.scope === 'day') } });
    const { penalty } = await w.penalties.record(w.recordInput());
    expect(await refusal(w.penalties.repost(w.dayId, penalty.id))).toMatchObject({ status: 409, code: 'no_card_channel' });
    w.close();

    w = await penaltyWorld();
    const recorded = await w.penalties.record(w.recordInput());
    w.discord.failNext('unavailable');
    expect(await refusal(w.penalties.repost(w.dayId, recorded.penalty.id))).toMatchObject({ status: 503, code: 'discord_unavailable' });
    expect(w.messagesIn('cup-penalties')).toHaveLength(1);
  });
});

describe('editing and voiding', () => {
  it('adds a revision with a snapshot per change, none for a no-op, and re-copies the judge’s player ID', async () => {
    w = await penaltyWorld();
    const { penalty } = await w.penalties.record(w.recordInput());
    const unchanged = await w.penalties.edit(w.dayId, penalty.id, { severity: 'Minor' }, { expectedRevision: 1, by: PEOPLE.brock });
    expect(unchanged.penalty.revision).toBe(1);
    const edited = await w.penalties.edit(w.dayId, penalty.id, { round: 4, judgeStaffMemberId: w.people.brock.id }, { expectedRevision: 1, by: PEOPLE.brock });
    expect(edited.penalty).toMatchObject({ revision: 2, round: 4, judge: { staffMemberId: w.people.brock.id, playerId: '00456' } });
    const snapshot = JSON.parse(w.database.sqlite.prepare('SELECT snapshot FROM penalty_revision WHERE revision = 2').pluck().get() as string);
    expect(snapshot).toMatchObject({ round: 4, judgeStaffId: w.people.brock.id, judgePlayerId: '00456' });
    expect(snapshot).not.toHaveProperty('discordMessageId');
  });

  it('refuses a stale revision, a voided penalty and a closed day, in that order', async () => {
    w = await penaltyWorld();
    const { penalty } = await w.penalties.record(w.recordInput());
    await w.penalties.edit(w.dayId, penalty.id, { severity: 'Major' }, { expectedRevision: 1, by: PEOPLE.brock });
    expect(await refusal(w.penalties.edit(w.dayId, penalty.id, { severity: 'Severe' }, { expectedRevision: 1, by: PEOPLE.brock }))).toEqual({
      status: 409,
      code: 'revision_conflict',
      data: { revision: 2 },
    });
    const voided = await w.penalties.voidPenalty(w.dayId, penalty.id, { reason: '  duplicate ', expectedRevision: 2, by: PEOPLE.brock });
    expect(voided.penalty).toMatchObject({ state: 'voided', voidReason: 'duplicate', revision: 3 });
    expect(await refusal(w.penalties.edit(w.dayId, penalty.id, { severity: 'Minor' }, { expectedRevision: 1, by: PEOPLE.brock }))).toMatchObject({ code: 'penalty_voided' });
    expect(await refusal(w.penalties.voidPenalty(w.dayId, penalty.id, { reason: 'x', expectedRevision: 3, by: PEOPLE.brock }))).toMatchObject({ code: 'penalty_voided' });

    const other = await w.penalties.record(w.recordInput());
    w.database.sqlite.prepare("UPDATE event_day SET state = 'closing' WHERE id = ?").run(w.dayId);
    expect(await refusal(w.penalties.edit(w.dayId, other.penalty.id, { severity: 'Major' }, { expectedRevision: 1, by: PEOPLE.brock }))).toMatchObject({ code: 'day_closing' });
  });

  it('shows a voided card without buttons and with who voided it', async () => {
    w = await penaltyWorld();
    const { penalty } = await w.penalties.record(w.recordInput());
    await w.penalties.voidPenalty(w.dayId, penalty.id, { reason: 'duplicate', expectedRevision: 1, by: PEOPLE.brock });
    const [card] = w.messagesIn('cup-penalties');
    expect(card!.embed!.title).toBe('VOIDED · Penalty #1 · Round 3');
    expect(card!.embed!.footer).toBe('Cup · Voided by Brock: duplicate');
    expect(card!.buttons).toEqual([]);
  });

  it('keeps an unchanged choice valid after it was deactivated or the game changed, and checks a new one', async () => {
    w = await penaltyWorld();
    const { penalty } = await w.penalties.record(w.recordInput({ penaltyTypeId: w.typeId('DPC') }));
    w.days.patchEvent(w.dayId, w.tcg.id, { game: 'vgc' });
    const edited = await w.penalties.edit(w.dayId, penalty.id, { notes: 'still DPC' }, { expectedRevision: 1, by: PEOPLE.brock });
    expect(edited.penalty.penaltyType.label).toBe('DPC');
    expect(await refusal(w.penalties.edit(w.dayId, penalty.id, { penaltyTypeId: w.typeId('QPC') }, { expectedRevision: 2, by: PEOPLE.brock }))).toMatchObject({
      code: 'invalid_catalog_choice',
      data: { field: 'penaltyTypeId' },
    });
  });

  it('edits the competitor and the category, and leaves a card that was never posted alone', async () => {
    w = await penaltyWorld();
    w.discord.failNext('unavailable');
    const { penalty } = await w.penalties.record(w.recordInput());
    const posts = w.discord.mutations.length;
    const edited = await w.penalties.edit(w.dayId, penalty.id, { competitorPlayerId: '42', categoryId: w.categoryId('Procedural') }, { expectedRevision: 1, by: PEOPLE.brock });
    expect(edited.penalty).toMatchObject({ competitorPlayerId: '42', category: { label: 'Procedural' }, cardState: 'failed' });
    expect(w.discord.mutations.length).toBe(posts);
  });

  it('refuses a void reason that is empty or too long', async () => {
    w = await penaltyWorld();
    const { penalty } = await w.penalties.record(w.recordInput());
    for (const reason of ['   ', 'x'.repeat(501)]) {
      expect(await refusal(w.penalties.voidPenalty(w.dayId, penalty.id, { reason, expectedRevision: 1, by: PEOPLE.brock }))).toMatchObject({ code: 'invalid_field', data: { field: 'reason' } });
    }
  });

  it('answers not found for a penalty of another day', async () => {
    w = await penaltyWorld();
    const { penalty } = await w.penalties.record(w.recordInput());
    const { day } = w.days.createDay({ date: '2026-10-18', title: 'Other' });
    expect(await refusal(w.penalties.edit(day.id, penalty.id, { severity: 'Major' }, { expectedRevision: 1, by: PEOPLE.brock }))).toMatchObject({ status: 404 });
  });
});

describe('who can be named the judge', () => {
  it('lists the event’s staff with a player ID that isn’t merely claimed, and refuses a claimed one', async () => {
    w = await penaltyWorld();
    w.directory.claim({ userId: PEOPLE.outsider, playerId: '5555', displayName: 'Outsider' });
    const claimed = w.directory.list().find((s) => s.linkState === 'claimed')!;
    const plan = w.days.plan(w.dayId);
    w.days.putStaff(w.dayId, [...plan.staff.map((s) => ({ staffMemberId: s.staffMemberId, events: s.events })), { staffMemberId: claimed.id, events: [{ eventId: w.tcg.id, role: 'judge' }] }]);
    expect(w.penalties.judges(w.dayId, w.tcg.id)).toEqual([
      { staffMemberId: w.people.ash.id, name: 'Ash', playerId: '00123' },
      { staffMemberId: w.people.brock.id, name: 'Brock', playerId: '00456' },
    ]);
    expect(await refusal(w.penalties.record(w.recordInput({ judgeStaffMemberId: claimed.id })))).toMatchObject({ code: 'judge_without_player_id' });
  });

  it('keeps a claim-created row that judged a penalty when a later claim on it is rejected', async () => {
    w = await penaltyWorld();
    w.directory.claim({ userId: PEOPLE.outsider, playerId: '5555', displayName: 'Outsider' });
    const row = w.directory.list().find((s) => s.playerId === '5555')!;
    w.directory.update(row.id, { discordUserId: PEOPLE.outsider });
    const plan = w.days.plan(w.dayId);
    const staff = plan.staff.map((s) => ({ staffMemberId: s.staffMemberId, events: s.events }));
    w.days.putStaff(w.dayId, [...staff, { staffMemberId: row.id, events: [{ eventId: w.tcg.id, role: 'judge' }] }]);
    await w.penalties.record(w.recordInput({ judgeStaffMemberId: row.id }));
    w.days.putStaff(w.dayId, staff);
    w.directory.update(row.id, { discordUserId: null });
    w.directory.claim({ userId: PEOPLE.admin, playerId: '5555', displayName: 'Admin' });

    expect(() => w.directory.rejectClaim(row.id)).not.toThrow();
    expect(w.directory.get(row.id)).toMatchObject({ playerId: '5555' });
    expect(w.penalties.namesJudge(row.id)).toBe(true);
    expect(w.penalties.namesJudge(w.people.gary.id)).toBe(false);
  });

  it('offers the event’s options and lists nothing for an event of another day', async () => {
    w = await penaltyWorld();
    expect(w.penalties.options(w.dayId, w.vgc.id).types.map((t) => t.label)).toEqual(['Warning', 'GL', 'DQ']);
    expect(w.penalties.list(w.dayId, [999_999])).toEqual([]);
    expect(w.penalties.get(999_999)).toBeNull();
    expect(w.penalties.locate(999_999)).toBeNull();
  });
});

describe('the catalog and the season', () => {
  const view = () => w.penalties.catalog();
  const asInput = (rows: readonly Omit<CatalogRow, 'season'>[]): CatalogRowInput[] => rows.map(({ id, label, games, rank, active }) => ({ id, label, games, rank, active }));

  it('a new day copies the current season, and an old day keeps its own', async () => {
    w = await penaltyWorld();
    w.penalties.setSeason('2027-28', '2026-27');
    const { day } = w.days.createDay({ date: '2026-11-01', title: 'Next' });
    expect(day.season).toBe('2027-28');
    expect(w.days.plan(w.dayId).day.season).toBe('2026-27');
    expect(w.penalties.catalog('2027-28').types.map((t) => t.label)).toEqual(['Warning', 'DPC', 'QPC', 'GL', 'DQ']);
  });

  it('refuses an empty new season without a source, and an unknown source', async () => {
    w = await penaltyWorld();
    expect(await refusal(() => w.penalties.setSeason('2027-28'))).toMatchObject({ status: 422, code: 'season_empty' });
    expect(await refusal(() => w.penalties.setSeason('2027-28', '1999-00'))).toMatchObject({ status: 422, code: 'unknown_season' });
    expect(w.penalties.catalog().currentSeason).toBe('2026-27');
    // A season that already has rows needs no source.
    expect(w.penalties.setSeason('2026-27')).toEqual({ currentSeason: '2026-27' });
  });

  it('relabels, adds and swaps labels in one save, and refuses a missing row, a duplicate, too many or no options, another season’s row', async () => {
    w = await penaltyWorld();
    const { categories, types } = view();
    const swapped = asInput(types).map((t) => ({ ...t, label: t.label === 'Warning' ? 'DQ' : t.label === 'DQ' ? 'Warning' : t.label === 'GL' ? 'Game Loss' : t.label }));
    const saved = w.penalties.putCatalog('2026-27', { categories: asInput(categories), types: [...swapped, { label: 'Caution', games: ['tcg', 'vgc', 'go', 'other'], rank: 9, active: true }] });
    expect(saved.types.map((t) => t.label)).toEqual(['DQ', 'DPC', 'QPC', 'Game Loss', 'Warning', 'Caution']);

    const current = view();
    const put = (types: CatalogRowInput[]) => refusal(() => w.penalties.putCatalog('2026-27', { categories: asInput(current.categories), types }));
    expect(await put(asInput(current.types).slice(1))).toMatchObject({ code: 'row_missing', data: { ids: [current.types[0]!.id] } });
    expect(await put([...asInput(current.types), { label: 'game loss', games: ['tcg'], rank: 1, active: true }])).toMatchObject({ code: 'duplicate_label' });
    const extra: CatalogRowInput[] = Array.from({ length: 20 }, (_, i) => ({ label: `T${i}`, games: ['tcg'], rank: 50 + i, active: true }));
    expect(await put([...asInput(current.types), ...extra])).toMatchObject({ code: 'too_many_options', data: { list: 'types', game: 'tcg' } });
    expect(await put(asInput(current.types).map((t) => ({ ...t, active: false })))).toMatchObject({ code: 'no_options', data: { list: 'types' } });
    w.penalties.setSeason('2027-28', '2026-27');
    const foreign = w.penalties.catalog('2027-28').types[0]!;
    expect(await put([...asInput(current.types), { ...asInput([foreign])[0]!, label: 'Moved' }])).toMatchObject({ code: 'unknown_row', data: { ids: [foreign.id] } });
    expect(w.penalties.catalog('2026-27').types).toEqual(current.types);
  });

  it('refuses a bad label, games or rank, and a season name outside the pattern', async () => {
    w = await penaltyWorld();
    const { categories, types } = view();
    const put = (change: (t: CatalogRowInput) => CatalogRowInput) => refusal(() => w.penalties.putCatalog('2026-27', { categories: asInput(categories), types: asInput(types).map((t, i) => (i === 0 ? change(t) : t)) }));
    for (const change of [
      (t: CatalogRowInput) => ({ ...t, label: '   ' }),
      (t: CatalogRowInput) => ({ ...t, label: 'x'.repeat(101) }),
      (t: CatalogRowInput) => ({ ...t, games: [] }),
      (t: CatalogRowInput) => ({ ...t, games: ['chess' as never] }),
      (t: CatalogRowInput) => ({ ...t, rank: -1 }),
      (t: CatalogRowInput) => ({ ...t, rank: 1000 }),
    ]) {
      expect(await put(change)).toMatchObject({ status: 422, code: 'invalid_field', data: { field: 'types' } });
    }
    const longest = w.penalties.putCatalog('2026-27', { categories: asInput(categories), types: asInput(types).map((t, i) => (i === 0 ? { ...t, label: 'x'.repeat(100) } : t)) });
    expect(longest.types.find((t) => t.id === types[0]!.id)?.label).toHaveLength(100);
    expect(await refusal(() => w.penalties.setSeason(' bad'))).toMatchObject({ code: 'invalid_field', data: { field: 'season' } });
  });

  it('answers not found for a season without rows, and refuses a row given twice', async () => {
    w = await penaltyWorld();
    expect(await refusal(() => w.penalties.catalog('1999-00'))).toMatchObject({ status: 404 });
    const { categories, types } = view();
    expect(await refusal(() => w.penalties.putCatalog('1999-00', { categories: [], types: [] }))).toMatchObject({ status: 404 });
    const twice = [...asInput(types), { ...asInput(types)[0]!, label: 'Again' }];
    expect(await refusal(() => w.penalties.putCatalog('2026-27', { categories: asInput(categories), types: twice }))).toMatchObject({
      code: 'duplicate_row',
      data: { ids: [types[0]!.id] },
    });
  });
});

describe('the CSV', () => {
  it('writes the active or the voided penalties of one event, and refuses an event without a Tournament ID', async () => {
    w = await penaltyWorld();
    const kept = await w.penalties.record(w.recordInput({ round: 2, notes: 'a, b' }));
    const gone = await w.penalties.record(w.recordInput({ round: 1 }));
    await w.penalties.voidPenalty(w.dayId, gone.penalty.id, { reason: 'dup', expectedRevision: 1, by: PEOPLE.brock });
    const active = w.penalties.csv(w.dayId, w.tcg.id, false);
    expect(active.filename).toBe('26-10-000123-penalties.csv');
    expect(active.rows).toBe(1);
    expect(active.body.split('\n')[1]).toBe('26-10-000123,2,00123,0012345,Game Play,Minor,Warning,"a, b"');
    const voided = w.penalties.csv(w.dayId, w.tcg.id, true);
    expect(voided.filename).toBe('26-10-000123-penalties-voided.csv');
    expect(voided.body.split('\n')[1]).toMatch(/^26-10-000123,1,/);
    expect(kept.penalty.id).not.toBe(gone.penalty.id);
    expect(await refusal(() => w.penalties.csv(w.dayId, w.vgc.id, false))).toMatchObject({ status: 422, code: 'export_blocked', data: { problems: [{ code: 'tournament_id_missing' }] } });
  });
});

describe('after the day closes', () => {
  const close = () => {
    w.days.markClosing(w.dayId, PEOPLE.brock, () => 0);
    w.days.markClosed(w.dayId, w.clock.now());
  };

  it('takes corrections only as corrections, and edits the card while the channel is there', async () => {
    w = await penaltyWorld();
    const { penalty } = await w.penalties.record(w.recordInput());
    close();
    expect(await refusal(w.penalties.edit(w.dayId, penalty.id, { notes: 'x' }, { expectedRevision: 1, by: PEOPLE.brock }))).toMatchObject({ code: 'day_not_open' });
    const edited = await w.penalties.edit(w.dayId, penalty.id, { notes: 'Corrected.' }, { expectedRevision: 1, by: PEOPLE.organizer, correction: true });
    expect(edited.penalty).toMatchObject({ revision: 2, notes: 'Corrected.' });
    expect(w.messagesIn('cup-penalties')[0]!.embed!.fields.some((f) => f.value === 'Corrected.')).toBe(true);
    expect(await refusal(w.penalties.record(w.recordInput()))).toMatchObject({ code: 'day_not_open' });
    expect(await refusal(() => w.penalties.repost(w.dayId, penalty.id))).toMatchObject({ code: 'day_not_open' });
  });

  it('makes no Discord call for a correction on a purged day', async () => {
    w = await penaltyWorld();
    const { penalty } = await w.penalties.record(w.recordInput());
    close();
    w.days.markPurged(w.dayId);
    const before = w.discord.restCalls;
    const voided = await w.penalties.voidPenalty(w.dayId, penalty.id, { reason: 'duplicate', expectedRevision: 1, by: PEOPLE.organizer, correction: true });
    expect(voided.penalty.state).toBe('voided');
    expect(w.discord.restCalls).toBe(before);
  });

  it('refuses every change while the day is closing, corrections too', async () => {
    w = await penaltyWorld();
    const { penalty } = await w.penalties.record(w.recordInput());
    w.days.markClosing(w.dayId, PEOPLE.brock, () => 0);
    expect(await refusal(w.penalties.edit(w.dayId, penalty.id, { notes: 'x' }, { expectedRevision: 1, by: PEOPLE.organizer, correction: true }))).toMatchObject({ status: 409, code: 'day_closing' });
  });

  it('answers the preflight’s recent penalties, the CSV’s source revision, and deletes a day’s penalties for retention', async () => {
    w = await penaltyWorld();
    const first = await w.penalties.record(w.recordInput());
    w.clock.advance(60_000);
    const second = await w.penalties.record(w.recordInput());
    w.clock.advance(14 * 60_000 + 1);
    expect(w.penalties.recentPenalties(w.dayId).map((p) => p.penaltyId)).toEqual([second.penalty.id]);
    const revision = w.penalties.sourceRevision(w.tcg.id);
    expect(revision).toBeGreaterThan(0);
    expect(w.penalties.sourceRevision(w.vgc.id)).toBe(0);
    await w.penalties.edit(w.dayId, first.penalty.id, { notes: 'x' }, { expectedRevision: 1, by: PEOPLE.brock });
    expect(w.penalties.sourceRevision(w.tcg.id)).toBeGreaterThan(revision);

    expect(w.penalties.deleteForDay(w.dayId)).toBe(2);
    expect(count('penalty')).toBe(0);
    expect(count('penalty_revision')).toBe(0);
  });
});
