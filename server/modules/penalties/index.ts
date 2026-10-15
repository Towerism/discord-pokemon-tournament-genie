/**
 * Penalties (ADR-0006): the catalog, recording exactly once, edits and voids as revisions, the card and the CSV.
 * The only module that writes the penalty and catalog tables. Who may act is decided by the callers through
 * `canSee`/`editRight` (ADR-0010) before they call in; this module enforces the penalty's own rules.
 *
 * Every database change commits before Discord is touched, and card work for one penalty runs one piece at a time,
 * so Discord failing never loses a penalty and a later revision is never overwritten by an earlier one.
 */
import type { Clock, Logger } from '@towerism/selfhost-kit';
import { and, asc, eq, inArray, max, sql } from 'drizzle-orm';
import {
  type Catalog,
  type CatalogRow,
  type Game,
  GAMES,
  LABEL_MAX,
  MAX_ACTIVE_OPTIONS,
  NOTES_MAX,
  PLAYER_ID,
  ROUND_MAX,
  SEASON,
  SEVERITIES,
  type Severity,
  TOURNAMENT_ID,
  VOID_REASON_MAX,
  catalogOptions,
  penaltiesCsv,
} from '../../../shared/penalties';
import type { Db } from '../../db/client';
import { penalty, penaltyCategory, penaltyRevision, penaltyType } from '../../db/schema';
import type { DirectoryService } from '../directory';
import type { DiscordGateway } from '../discord/port';
import { ServiceError, notFound } from '../errors';
import type { EventDaysService, EventView } from '../event-days';
import type { ProvisioningService } from '../provisioning';
import { renderCard } from './card';

type PenaltyRow = typeof penalty.$inferSelect;
type CatalogTable = typeof penaltyCategory | typeof penaltyType;
export type CardState = PenaltyRow['cardState'];

export interface PenaltyView {
  id: number;
  eventId: number;
  number: number;
  round: number;
  competitorPlayerId: string;
  category: { id: number; label: string };
  severity: Severity;
  penaltyType: { id: number; label: string };
  notes: string;
  judge: { staffMemberId: number; name: string; playerId: string };
  /** The judge's Discord account, for the edit window (not part of the website's view). */
  judgeDiscordUserId: string | null;
  recordedBy: string;
  recordedAt: number;
  state: PenaltyRow['state'];
  voidReason: string | null;
  revision: number;
  cardState: CardState;
  revisions: { revision: number; action: 'recorded' | 'edited' | 'voided'; editedBy: string; editedByName: string | null; editedAt: number }[];
}

export interface RecordInput {
  dayId: number;
  eventId: number;
  /** `discord:<command interaction ID>` or `web:<UUID>`. */
  key: string;
  round: number;
  competitorPlayerId: string;
  categoryId: number;
  severity: Severity;
  penaltyTypeId: number;
  notes: string;
  judgeStaffMemberId: number;
  /** The Discord user recording it. */
  recordedBy: string;
}

export type PenaltyPatch = Partial<Pick<RecordInput, 'round' | 'competitorPlayerId' | 'categoryId' | 'severity' | 'penaltyTypeId' | 'notes' | 'judgeStaffMemberId'>>;

export interface CatalogRowInput {
  id?: number;
  label: string;
  games: Game[];
  rank: number;
  active: boolean;
}

export interface CatalogView {
  currentSeason: string;
  seasons: string[];
  season: string;
  categories: Omit<CatalogRow, 'season'>[];
  types: Omit<CatalogRow, 'season'>[];
}

const invalid = (field: string, message: string) => new ServiceError(422, 'invalid_field', message, { field });
const isUniqueKeyClash = (err: unknown) => err instanceof Error && /UNIQUE constraint failed: penalty\.idempotency_key/.test(err.message);

export function createPenaltiesService(opts: {
  db: Db;
  clock: Clock;
  logger: Logger;
  eventDays: EventDaysService;
  directory: DirectoryService;
  provisioning: ProvisioningService;
  gateway: () => DiscordGateway;
  /** Settings' current season, owned by `setup`. */
  season: { current: () => string; put: (season: string, now: number) => void };
  /** Test seam: runs between the key lookup and the insert. */
  testHooks?: { beforeInsert?: (key: string) => void };
}) {
  const { db, clock, logger, eventDays, directory, provisioning, gateway, season, testHooks = {} } = opts;

  // ---- catalog

  const toRow = (r: typeof penaltyCategory.$inferSelect): CatalogRow => ({ id: r.id, season: r.season, label: r.label, games: JSON.parse(r.games) as Game[], rank: r.rank, active: r.active });
  const rowsOf = (table: CatalogTable, s: string) => db.select().from(table).where(eq(table.season, s)).all().map(toRow);
  const catalogOf = (s: string): Catalog => ({ categories: rowsOf(penaltyCategory, s), types: rowsOf(penaltyType, s) });
  const byRank = (a: CatalogRow, b: CatalogRow) => a.rank - b.rank || a.id - b.id;
  const strip = ({ season: _season, ...rest }: CatalogRow) => rest;

  function seasons(): string[] {
    const first = new Map<string, number>();
    for (const table of [penaltyCategory, penaltyType]) {
      for (const r of db.select({ season: table.season, at: sql<number>`min(${table.createdAt})` }).from(table).groupBy(table.season).all()) {
        first.set(r.season, Math.min(first.get(r.season) ?? Infinity, r.at));
      }
    }
    return [...first].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0])).map(([s]) => s);
  }

  function catalogView(s: string): CatalogView {
    const { categories, types } = catalogOf(s);
    if (!categories.length && !types.length) throw notFound('season');
    return { currentSeason: season.current(), seasons: seasons(), season: s, categories: [...categories].sort(byRank).map(strip), types: [...types].sort(byRank).map(strip) };
  }

  function checkList(list: 'categories' | 'types', s: string, table: CatalogTable, items: readonly CatalogRowInput[]) {
    const existing = rowsOf(table, s);
    const ids = new Set(existing.map((r) => r.id));
    const given = items.filter((i) => i.id !== undefined).map((i) => i.id!);
    const repeated = given.filter((id, n) => given.indexOf(id) !== n);
    if (repeated.length) throw new ServiceError(422, 'duplicate_row', 'A row appears twice.', { list, ids: [...new Set(repeated)] });
    const unknown = items.filter((i) => i.id !== undefined && !ids.has(i.id)).map((i) => i.id!);
    if (unknown.length) throw new ServiceError(422, 'unknown_row', 'A row belongs to another season or list.', { list, ids: unknown });
    const present = new Set(given);
    const missing = existing.filter((r) => !present.has(r.id)).map((r) => r.id);
    if (missing.length) throw new ServiceError(422, 'row_missing', 'Rows are never deleted: deactivate them instead.', { list, ids: missing });
    const labels = new Set<string>();
    for (const i of items) {
      const label = i.label.trim();
      if (!label || label.length > LABEL_MAX) throw invalid(list, `Labels are 1 to ${LABEL_MAX} characters.`);
      if (labels.has(label.toLowerCase())) throw new ServiceError(422, 'duplicate_label', 'Labels must be unique.', { list, label });
      labels.add(label.toLowerCase());
      if (!i.games.length || i.games.some((g) => !GAMES.includes(g))) throw invalid(list, 'Pick at least one game.');
      if (!Number.isInteger(i.rank) || i.rank < 0 || i.rank > 999) throw invalid(list, 'Ranks are whole numbers from 0 to 999.');
    }
    for (const game of GAMES) {
      const active = items.filter((i) => i.active && i.games.includes(game)).length;
      if (active > MAX_ACTIVE_OPTIONS) throw new ServiceError(422, 'too_many_options', `At most ${MAX_ACTIVE_OPTIONS} active options per game.`, { list, game });
      if (active === 0) throw new ServiceError(422, 'no_options', 'Every game needs at least one active option.', { list, game });
    }
  }

  /** Two passes, so labels can be swapped in one save without tripping the unique index. */
  function writeList(table: CatalogTable, s: string, items: readonly CatalogRowInput[]) {
    const now = clock.now();
    const updates = items.filter((i): i is CatalogRowInput & { id: number } => i.id !== undefined);
    for (const i of updates) db.update(table).set({ label: `\u2063${i.id}` }).where(eq(table.id, i.id)).run();
    for (const i of updates) db.update(table).set({ label: i.label.trim(), games: JSON.stringify(i.games), rank: i.rank, active: i.active }).where(eq(table.id, i.id)).run();
    for (const i of items.filter((i) => i.id === undefined)) {
      db.insert(table).values({ season: s, label: i.label.trim(), games: JSON.stringify(i.games), rank: i.rank, active: i.active, createdAt: now }).run();
    }
  }

  // ---- penalties: reads

  const rowById = (id: number) => db.select().from(penalty).where(eq(penalty.id, id)).get() ?? null;
  const labelOf = (table: CatalogTable, id: number) => db.select({ label: table.label }).from(table).where(eq(table.id, id)).get()?.label ?? '';

  function view(r: PenaltyRow): PenaltyView {
    const judge = directory.get(r.judgeStaffId);
    const revisions = db.select().from(penaltyRevision).where(eq(penaltyRevision.penaltyId, r.id)).orderBy(asc(penaltyRevision.revision)).all();
    return {
      id: r.id,
      eventId: r.eventId,
      number: r.number,
      round: r.round,
      competitorPlayerId: r.competitorPlayerId,
      category: { id: r.categoryId, label: labelOf(penaltyCategory, r.categoryId) },
      severity: r.severity,
      penaltyType: { id: r.penaltyTypeId, label: labelOf(penaltyType, r.penaltyTypeId) },
      notes: r.notes,
      judge: { staffMemberId: r.judgeStaffId, name: judge?.displayName ?? '', playerId: r.judgePlayerId },
      judgeDiscordUserId: judge?.discordUserId ?? null,
      recordedBy: r.recordedBy,
      recordedAt: r.recordedAt,
      state: r.state,
      voidReason: r.voidReason,
      revision: r.revision,
      cardState: r.cardState,
      revisions: revisions.map((v) => ({ revision: v.revision, action: v.action, editedBy: v.editedBy, editedByName: directory.byDiscordUser(v.editedBy)?.displayName ?? null, editedAt: v.editedAt })),
    };
  }

  /** The day and the event, or not found; the penalty's day must be the one the caller named. */
  function dayEvent(dayId: number, eventId: number): { day: ReturnType<EventDaysService['plan']>; event: EventView } {
    const plan = eventDays.plan(dayId);
    const ev = plan.events.find((e) => e.id === eventId);
    if (!ev) throw notFound('event');
    return { day: plan, event: ev };
  }

  function penaltyOfDay(dayId: number, id: number): { row: PenaltyRow; plan: ReturnType<EventDaysService['plan']>; event: EventView } {
    const row = rowById(id);
    if (!row) throw notFound('penalty');
    const plan = eventDays.plan(dayId);
    const ev = plan.events.find((e) => e.id === row.eventId);
    if (!ev) throw notFound('penalty');
    return { row, plan, event: ev };
  }

  const requireOpen = (plan: ReturnType<EventDaysService['plan']>) => {
    if (plan.day.state !== 'open') throw new ServiceError(409, 'day_not_open', 'Penalties change only while the day is open.');
  };

  /** A staffer of the event with a player ID that an organizer has confirmed or imported (not just claimed). */
  function judgeOf(plan: ReturnType<EventDaysService['plan']>, eventId: number, staffMemberId: number) {
    const onEvent = plan.staff.find((s) => s.staffMemberId === staffMemberId && s.events.some((e) => e.eventId === eventId));
    if (!onEvent) throw new ServiceError(422, 'judge_not_on_event', 'The judge must be on this event’s staff.');
    const person = directory.get(staffMemberId);
    if (!person?.playerId || person.linkState === 'claimed') throw new ServiceError(422, 'judge_without_player_id', 'The judge needs a confirmed player ID.');
    return person;
  }

  function checkFields(p: PenaltyPatch) {
    if (p.round !== undefined && (!Number.isInteger(p.round) || p.round < 1 || p.round > ROUND_MAX)) throw invalid('round', `Round: a whole number from 1 to ${ROUND_MAX}.`);
    if (p.competitorPlayerId !== undefined && !PLAYER_ID.test(p.competitorPlayerId)) throw invalid('competitorPlayerId', "Competitor's player ID: digits only, up to 10.");
    if (p.severity !== undefined && !SEVERITIES.includes(p.severity)) throw invalid('severity', 'Severity: Minor, Major or Severe.');
    if (p.notes !== undefined && p.notes.trim().length > NOTES_MAX) throw invalid('notes', `Notes: at most ${NOTES_MAX} characters.`);
  }

  function checkChoices(seasonName: string, game: Game, p: { categoryId?: number; penaltyTypeId?: number }) {
    const offered = catalogOptions(catalogOf(seasonName), seasonName, game);
    if (p.categoryId !== undefined && !offered.categories.some((c) => c.id === p.categoryId)) {
      throw new ServiceError(422, 'invalid_catalog_choice', 'That category isn’t offered for this event.', { field: 'categoryId' });
    }
    if (p.penaltyTypeId !== undefined && !offered.types.some((t) => t.id === p.penaltyTypeId)) {
      throw new ServiceError(422, 'invalid_catalog_choice', 'That penalty isn’t offered for this event.', { field: 'penaltyTypeId' });
    }
  }

  const snapshot = (r: PenaltyRow) => {
    const { discordChannelId: _c, discordMessageId: _m, cardState: _s, ...fields } = r;
    return JSON.stringify(fields);
  };
  const writeRevision = (r: PenaltyRow, action: 'recorded' | 'edited' | 'voided', by: string) =>
    db.insert(penaltyRevision).values({ penaltyId: r.id, revision: r.revision, action, snapshot: snapshot(r), editedBy: by, editedAt: clock.now() }).run();

  function keyHit(existing: PenaltyRow, input: Pick<RecordInput, 'eventId' | 'recordedBy'>): { id: number; created: false } {
    // Only the same recorder on the same event gets the row back: a forged key reads nothing.
    if (existing.eventId !== input.eventId || existing.recordedBy !== input.recordedBy) throw new ServiceError(409, 'idempotency_conflict', 'This form can’t be used again.');
    return { id: existing.id, created: false };
  }

  // ---- the card

  const queues = new Map<number, Promise<void>>();
  /** Card work for one penalty, one piece at a time; the result is the work's own. */
  function serialize<T>(id: number, work: () => Promise<T>): Promise<T> {
    const result = (queues.get(id) ?? Promise.resolve()).then(work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    queues.set(id, tail);
    void tail.then(() => {
      if (queues.get(id) === tail) queues.delete(id);
    });
    return result;
  }

  /** The event's penalties channel, else its first per-event channel; never a day-wide one (ADR-0010). */
  function cardChannel(dayId: number, eventId: number): string | null {
    const plan = eventDays.plan(dayId);
    const blueprint = eventDays.blueprint(plan.day.blueprintId);
    const candidates = provisioning
      .channels(dayId)
      .filter((c) => c.eventId === eventId && c.state === 'present')
      .flatMap((c) => {
        const meta = blueprint.channels.find((b) => b.key === c.key && b.scope === 'per_event');
        return meta ? [{ id: c.discordChannelId, rank: (meta.purpose === 'penalties' ? 0 : 1000) + meta.position }] : [];
      })
      .sort((a, b) => a.rank - b.rank);
    return candidates[0]?.id ?? null;
  }

  function cardFor(r: PenaltyRow) {
    const v = view(r);
    const eventName = eventDays.plan(dayIdOf(r)).events.find((e) => e.id === r.eventId)?.name ?? '';
    const last = v.revisions.at(-1);
    return renderCard(v, eventName, last ? (last.editedByName ?? null) : null);
  }
  const dayIdOf = (r: PenaltyRow) => eventDays.dayOfEvent(r.eventId);
  const setCard = (id: number, patch: Partial<Pick<PenaltyRow, 'cardState' | 'discordChannelId' | 'discordMessageId'>>) => db.update(penalty).set(patch).where(eq(penalty.id, id)).run();

  const postFirst = (id: number) =>
    serialize(id, async () => {
      const r = rowById(id)!;
      const channelId = cardChannel(dayIdOf(r), r.eventId);
      if (!channelId) return setCard(id, { cardState: 'none' });
      try {
        const messageId = await gateway().postMessage(channelId, cardFor(r));
        setCard(id, { cardState: 'posted', discordChannelId: channelId, discordMessageId: messageId });
      } catch (err) {
        logger.warn('Could not post a penalty card.', { penaltyId: id, err });
        setCard(id, { cardState: 'failed' });
      }
    });

  const refresh = (id: number) =>
    serialize(id, async () => {
      const r = rowById(id)!;
      if (!r.discordChannelId || !r.discordMessageId) return;
      try {
        const outcome = await gateway().editMessage(r.discordChannelId, r.discordMessageId, cardFor(r));
        setCard(id, { cardState: outcome === 'gone' ? 'missing' : 'posted' });
      } catch (err) {
        logger.warn('Could not edit a penalty card.', { penaltyId: id, err });
        setCard(id, { cardState: 'failed' });
      }
    });

  return {
    // ---- catalog and season

    catalog(s?: string): CatalogView {
      return catalogView(s ?? season.current());
    },

    putCatalog(s: string, input: { categories: CatalogRowInput[]; types: CatalogRowInput[] }): CatalogView {
      return db.transaction(() => {
        if (!rowsOf(penaltyCategory, s).length && !rowsOf(penaltyType, s).length) throw notFound('season');
        checkList('categories', s, penaltyCategory, input.categories);
        checkList('types', s, penaltyType, input.types);
        writeList(penaltyCategory, s, input.categories);
        writeList(penaltyType, s, input.types);
        logger.info('Penalty catalog saved.', { season: s });
        return catalogView(s);
      });
    },

    /** Sets the current season; a season without rows starts as a copy of `copyFrom`. Existing days keep theirs. */
    setSeason(s: string, copyFrom?: string): { currentSeason: string } {
      if (!SEASON.test(s)) throw invalid('season', 'Seasons are letters, digits, spaces, dots, dashes and underscores, up to 32.');
      return db.transaction(() => {
        const hasRows = (name: string) => rowsOf(penaltyCategory, name).length + rowsOf(penaltyType, name).length > 0;
        if (!hasRows(s)) {
          if (copyFrom === undefined) throw new ServiceError(422, 'season_empty', 'A new season starts as a copy of another.');
          if (!hasRows(copyFrom)) throw new ServiceError(422, 'unknown_season', 'No such season to copy.');
          const now = clock.now();
          for (const table of [penaltyCategory, penaltyType]) {
            for (const r of rowsOf(table, copyFrom)) db.insert(table).values({ season: s, label: r.label, games: JSON.stringify(r.games), rank: r.rank, active: r.active, createdAt: now }).run();
          }
        }
        season.put(s, clock.now());
        logger.info('Current season set.', { season: s, copyFrom: copyFrom ?? null });
        return { currentSeason: s };
      });
    },

    /** What `/penalty` and the website offer for an event. */
    options(dayId: number, eventId: number) {
      const { day, event: ev } = dayEvent(dayId, eventId);
      const offered = catalogOptions(catalogOf(day.day.season), day.day.season, ev.game);
      return { categories: offered.categories.map((c) => ({ id: c.id, label: c.label })), types: offered.types.map((t) => ({ id: t.id, label: t.label })) };
    },

    /** The event's staffers who can be named as the judge: a player ID not merely claimed. */
    judges(dayId: number, eventId: number) {
      const { day } = dayEvent(dayId, eventId);
      const ids = day.staff.filter((s) => s.events.some((e) => e.eventId === eventId)).map((s) => s.staffMemberId);
      return directory
        .byIds(ids)
        .filter((p) => p.playerId !== null && p.linkState !== 'claimed')
        .map((p) => ({ staffMemberId: p.id, name: p.displayName, playerId: p.playerId! }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.staffMemberId - b.staffMemberId);
    },

    // ---- penalties

    /** Whether a penalty names the staffer as its judge: the directory then keeps their row. */
    namesJudge(staffMemberId: number): boolean {
      return db.select({ id: penalty.id }).from(penalty).where(eq(penalty.judgeStaffId, staffMemberId)).get() !== undefined;
    },

    get(id: number): PenaltyView | null {
      const r = rowById(id);
      return r ? view(r) : null;
    },

    /** The penalty with the day it belongs to, for the callers' authorization. */
    locate(id: number): { penalty: PenaltyView; dayId: number } | null {
      const r = rowById(id);
      return r ? { penalty: view(r), dayId: dayIdOf(r) } : null;
    },

    list(dayId: number, eventIds: readonly number[]): PenaltyView[] {
      const ids = eventDays.plan(dayId).events.filter((e) => eventIds.includes(e.id)).map((e) => e.id);
      if (!ids.length) return [];
      return db.select().from(penalty).where(inArray(penalty.eventId, ids)).orderBy(asc(penalty.eventId), asc(penalty.number)).all().map(view);
    },

    async record(input: RecordInput): Promise<{ penalty: PenaltyView; created: boolean }> {
      const outcome = db.transaction(() => {
        const existing = db.select().from(penalty).where(eq(penalty.idempotencyKey, input.key)).get();
        if (existing) return keyHit(existing, input);
        const { day, event: ev } = dayEvent(input.dayId, input.eventId);
        requireOpen(day);
        checkFields(input);
        checkChoices(day.day.season, ev.game, input);
        const judge = judgeOf(day, ev.id, input.judgeStaffMemberId);
        testHooks.beforeInsert?.(input.key);
        const number = (db.select({ n: max(penalty.number) }).from(penalty).where(eq(penalty.eventId, ev.id)).get()?.n ?? 0) + 1;
        let inserted: PenaltyRow;
        try {
          inserted = db
            .insert(penalty)
            .values({
              eventId: ev.id,
              number,
              idempotencyKey: input.key,
              round: input.round,
              competitorPlayerId: input.competitorPlayerId,
              categoryId: input.categoryId,
              severity: input.severity,
              penaltyTypeId: input.penaltyTypeId,
              notes: input.notes.trim(),
              judgeStaffId: judge.id,
              judgePlayerId: judge.playerId!,
              recordedBy: input.recordedBy,
              recordedAt: clock.now(),
              state: 'active',
              revision: 1,
              cardState: 'pending',
            })
            .returning()
            .get();
        } catch (err) {
          // The unique index is the backstop: a row with this key appeared since the lookup.
          if (!isUniqueKeyClash(err)) throw err;
          return keyHit(db.select().from(penalty).where(eq(penalty.idempotencyKey, input.key)).get()!, input);
        }
        writeRevision(inserted, 'recorded', input.recordedBy);
        return { id: inserted.id, created: true as const };
      });
      if (outcome.created) {
        logger.info('Penalty recorded.', { penaltyId: outcome.id, eventId: input.eventId, dayId: input.dayId });
        await postFirst(outcome.id);
      }
      return { penalty: view(rowById(outcome.id)!), created: outcome.created };
    },

    async edit(dayId: number, id: number, patch: PenaltyPatch, opts: { expectedRevision: number; by: string }): Promise<{ penalty: PenaltyView }> {
      const changed = db.transaction(() => {
        const { row, plan, event: ev } = penaltyOfDay(dayId, id);
        refuseChange(row, plan, opts.expectedRevision);
        checkFields(patch);
        const next: Partial<PenaltyRow> = {};
        if (patch.round !== undefined && patch.round !== row.round) next.round = patch.round;
        if (patch.competitorPlayerId !== undefined && patch.competitorPlayerId !== row.competitorPlayerId) next.competitorPlayerId = patch.competitorPlayerId;
        if (patch.severity !== undefined && patch.severity !== row.severity) next.severity = patch.severity;
        if (patch.notes !== undefined && patch.notes.trim() !== row.notes) next.notes = patch.notes.trim();
        if (patch.categoryId !== undefined && patch.categoryId !== row.categoryId) next.categoryId = patch.categoryId;
        if (patch.penaltyTypeId !== undefined && patch.penaltyTypeId !== row.penaltyTypeId) next.penaltyTypeId = patch.penaltyTypeId;
        // An unchanged choice stays valid even if it was deactivated, or the event's game changed, since.
        checkChoices(plan.day.season, ev.game, { categoryId: next.categoryId, penaltyTypeId: next.penaltyTypeId });
        if (patch.judgeStaffMemberId !== undefined && patch.judgeStaffMemberId !== row.judgeStaffId) {
          const judge = judgeOf(plan, ev.id, patch.judgeStaffMemberId);
          next.judgeStaffId = judge.id;
          next.judgePlayerId = judge.playerId!;
        }
        if (!Object.keys(next).length) return false;
        const updated = db
          .update(penalty)
          .set({ ...next, revision: row.revision + 1 })
          .where(eq(penalty.id, id))
          .returning()
          .get();
        writeRevision(updated, 'edited', opts.by);
        return true;
      });
      if (changed) {
        logger.info('Penalty edited.', { penaltyId: id, dayId });
        await refresh(id);
      }
      return { penalty: view(rowById(id)!) };
    },

    async voidPenalty(dayId: number, id: number, opts: { reason: string; expectedRevision: number; by: string }): Promise<{ penalty: PenaltyView }> {
      db.transaction(() => {
        const { row, plan } = penaltyOfDay(dayId, id);
        refuseChange(row, plan, opts.expectedRevision);
        const reason = opts.reason.trim();
        if (!reason || reason.length > VOID_REASON_MAX) throw invalid('reason', `Reason: 1 to ${VOID_REASON_MAX} characters.`);
        const updated = db
          .update(penalty)
          .set({ state: 'voided', voidReason: reason, revision: row.revision + 1 })
          .where(eq(penalty.id, id))
          .returning()
          .get();
        writeRevision(updated, 'voided', opts.by);
      });
      logger.info('Penalty voided.', { penaltyId: id, dayId });
      await refresh(id);
      return { penalty: view(rowById(id)!) };
    },

    /** Posts a fresh card, stores it, then removes the old one best-effort (§6.4: "Repost card"). */
    repost(dayId: number, id: number): Promise<PenaltyView> {
      penaltyOfDay(dayId, id);
      return serialize(id, async () => {
        const r = rowById(id)!;
        const channelId = cardChannel(dayId, r.eventId);
        if (!channelId) throw new ServiceError(409, 'no_card_channel', 'This event has no channel for the card.');
        let messageId: string;
        try {
          messageId = await gateway().postMessage(channelId, cardFor(r));
        } catch (err) {
          // Unreachable, refused or the channel gone (until the next sync recreates it): the stored card is unchanged.
          logger.warn('Could not repost a penalty card.', { penaltyId: id, err });
          throw new ServiceError(503, 'discord_unavailable', 'Discord can’t take the card right now. Try again, or sync the day first.');
        }
        setCard(id, { cardState: 'posted', discordChannelId: channelId, discordMessageId: messageId });
        if (r.discordChannelId && r.discordMessageId) {
          await gateway()
            .deleteMessage(r.discordChannelId, r.discordMessageId)
            .catch((err: unknown) => logger.warn('Could not remove the old penalty card.', { penaltyId: id, err }));
        }
        logger.info('Penalty card reposted.', { penaltyId: id, dayId });
        return view(rowById(id)!);
      });
    },

    /** One event's file (§6.6): the active penalties, or the voided ones. */
    csv(dayId: number, eventId: number, voided: boolean): { filename: string; body: string; rows: number } {
      const { event: ev } = dayEvent(dayId, eventId);
      if (!ev.tournamentId || !TOURNAMENT_ID.test(ev.tournamentId)) {
        throw new ServiceError(422, 'export_blocked', 'Add the event’s Tournament ID first.', { problems: [{ code: 'tournament_id_missing' }] });
      }
      const rows = db
        .select()
        .from(penalty)
        .where(and(eq(penalty.eventId, eventId), eq(penalty.state, voided ? 'voided' : 'active')))
        .all();
      const body = penaltiesCsv(
        ev.tournamentId,
        rows.map((r) => ({
          number: r.number,
          round: r.round,
          recordedAt: r.recordedAt,
          judgePlayerId: r.judgePlayerId,
          competitorPlayerId: r.competitorPlayerId,
          category: labelOf(penaltyCategory, r.categoryId),
          severity: r.severity,
          penaltyType: labelOf(penaltyType, r.penaltyTypeId),
          notes: r.notes,
        })),
      );
      return { filename: `${ev.tournamentId}-penalties${voided ? '-voided' : ''}.csv`, body, rows: rows.length };
    },
  };

  /** The penalty's own refusals, after the caller was authorized: voided, then the day, then a stale revision. */
  function refuseChange(row: PenaltyRow, plan: ReturnType<EventDaysService['plan']>, expectedRevision: number) {
    if (row.state === 'voided') throw new ServiceError(409, 'penalty_voided', 'This penalty was voided.');
    requireOpen(plan);
    if (row.revision !== expectedRevision) throw new ServiceError(409, 'revision_conflict', 'Someone changed this penalty since.', { revision: row.revision });
  }
}

export type PenaltiesService = ReturnType<typeof createPenaltiesService>;
