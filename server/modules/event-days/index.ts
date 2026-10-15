/**
 * Event days (§5.2, §6.2): blueprints, day templates, days, events and their staff. The day plan is the desired
 * state provisioning applies (ADR-0005). Every plan change bumps the day's revision; a change on an open day that
 * takes access away queues a sync in the same transaction.
 */
import type { Clock, Logger } from '@towerism/selfhost-kit';
import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import {
  type BlueprintInput,
  type DesiredContext,
  type EventRole,
  type PlanInput,
  deriveSlug,
  desiredChannels,
  revokesAccess,
  validateBlueprint,
} from '../../../shared/blueprints';
import { localTimeOf, zonedInstant } from '../../../shared/time';
import type { Db } from '../../db/client';
import { blueprint, blueprintChannel, dayStaff, dayTemplate, dayTemplateEvent, event, eventDay, eventStaff, type GAMES } from '../../db/schema';
import type { DirectoryService } from '../directory';
import { ServiceError, notFound } from '../errors';

export type Game = (typeof GAMES)[number];
type DayRow = typeof eventDay.$inferSelect;
type EventRow = typeof event.$inferSelect;

export interface Blueprint extends BlueprintInput {
  id: number;
  isDefault: boolean;
  inUse: boolean;
}

export interface DayTemplate {
  id: number;
  name: string;
  blueprintId: number;
  events: { name: string; game: Game; startTime: string }[];
}

export interface DaySummary {
  id: number;
  date: string;
  title: string;
  state: DayRow['state'];
  /** Selects the penalty catalog; copied from the current season when the day was created. */
  season: string;
  eventCount: number;
  staffCount: number;
}

export interface EventView {
  id: number;
  name: string;
  slug: string;
  game: Game;
  gameConfirmed: boolean;
  startTime: string;
  startsAt: number;
  tournamentId: string | null;
  /** The tournament an import created it from, and that tournament's organizer (§4.2). */
  attendance: { tournamentId: string; organizerPlayerId: string | null; organizerName: string | null } | null;
}

export interface DayStaffView {
  staffMemberId: number;
  displayName: string;
  linkState: 'unlinked' | 'claimed' | 'linked';
  discordUserId: string | null;
  events: { eventId: number; role: EventRole }[];
}

export interface DayPlanCore {
  day: DaySummary & {
    blueprintId: number;
    categoryId: string | null;
    attendance: { source: DayRow['source']; refreshedAt: number | null };
  };
  events: EventView[];
  staff: DayStaffView[];
  sync: { inSync: boolean; planRevision: number; appliedRevision: number | null; revocationPending: boolean };
}

export interface StaffEntry {
  staffMemberId: number;
  events: { eventId: number; role: EventRole }[];
}

type RoleRef = { staffMemberId: number; eventId: number; role: EventRole };

export interface StaffDiff {
  added: number[];
  removed: number[];
  eventRolesAdded: RoleRef[];
  eventRolesRemoved: RoleRef[];
  eventRolesChanged: (RoleRef & { from: EventRole })[];
}

/** The day as an attendance import reads it (§4.2). */
export interface ImportStateView {
  dayState: DayRow['state'];
  planRevision: number;
  events: {
    id: number;
    name: string;
    startsAt: number;
    game: Game;
    gameConfirmed: boolean;
    tournamentId: string | null;
    attendanceTournamentId: string | null;
    organizerPlayerId: string | null;
    organizerName: string | null;
  }[];
  staff: { staffMemberId: number; displayName: string; playerId: string | null; dayImported: boolean; roles: { eventId: number; role: EventRole; imported: boolean }[] }[];
}

/** What an accepted import changes, decided by `attendance-import`; applied here, where the tables live. */
export interface ImportOps {
  createEvents: {
    name: string;
    startsAt: number;
    game: Game;
    gameConfirmed: boolean;
    tournamentId: string | null;
    attendanceTournamentId: string;
    organizer: { playerId: string; name: string };
    staff: { staffMemberId: number; role: EventRole }[];
  }[];
  deleteEvents: number[];
  /** Kept with their channels, every role ended and the attendance link cleared (an open day's removal). */
  retireEvents: number[];
  changeEvents: { eventId: number; name?: string; startsAt?: number; tournamentId?: string | null; game?: Game }[];
  addRoles: { eventId: number; staffMemberId: number; role: EventRole }[];
  removeRoles: { eventId: number; staffMemberId: number }[];
  changeRoles: { eventId: number; staffMemberId: number; role: EventRole }[];
  organizers: { eventId: number; playerId: string; name: string }[];
  refreshedAt: number;
}

export interface Alarm {
  kind: 'access_not_revoked';
  dayId: number;
  title: string;
  since: number;
}

/** Audiences depend only on the plan and these two sets; IDs here never change an audience. */
const REMOVAL_CTX: DesiredContext = { guildId: '0', botUserId: '0', organizerRoleId: '0', headJudgeRoleHolders: new Set(), guildMemberIds: null };

export function createEventDaysService(opts: {
  db: Db;
  clock: Clock;
  logger: Logger;
  /** The store's zone (`TZ`): days are its calendar dates, start times its local times. */
  timeZone: string;
  /** The bound guild, or `null` before setup. */
  guildId: () => string | null;
  directory: DirectoryService;
  /** Queues a sync for the day, coalesced with one already queued; answers the job ID. */
  enqueueSync: (dayId: number) => number;
  /** Settings' current season, which a new day copies (§5.2). */
  currentSeason: () => string;
}) {
  const { db, clock, logger, timeZone, guildId, directory, enqueueSync, currentSeason } = opts;

  // ---- reads

  const dayRow = (id: number): DayRow => db.select().from(eventDay).where(eq(eventDay.id, id)).get() ?? (() => {
    throw notFound('day');
  })();
  const eventsOf = (dayId: number): EventRow[] => db.select().from(event).where(eq(event.dayId, dayId)).orderBy(asc(event.startsAt), asc(event.name), asc(event.id)).all();

  function blueprintRows(id: number): Blueprint | null {
    const b = db.select().from(blueprint).where(eq(blueprint.id, id)).get();
    if (!b) return null;
    const channels = db.select().from(blueprintChannel).where(eq(blueprintChannel.blueprintId, id)).orderBy(asc(blueprintChannel.position), asc(blueprintChannel.key)).all();
    const usedByDay = db.select({ id: eventDay.id }).from(eventDay).where(eq(eventDay.blueprintId, id)).get();
    const usedByTemplate = db.select({ id: dayTemplate.id }).from(dayTemplate).where(eq(dayTemplate.blueprintId, id)).get();
    return {
      id: b.id,
      name: b.name,
      categoryNamePattern: b.categoryNamePattern,
      isDefault: b.isDefault,
      inUse: usedByDay !== undefined || usedByTemplate !== undefined,
      channels: channels.map((c) => ({ key: c.key, scope: c.scope, kind: c.kind, namePattern: c.namePattern, audience: c.audience, purpose: c.purpose, topic: c.topic, position: c.position })),
    };
  }

  function staffEntries(dayId: number): StaffEntry[] {
    const members = db.select().from(dayStaff).where(eq(dayStaff.dayId, dayId)).all();
    const roles = db
      .select({ eventId: eventStaff.eventId, staffMemberId: eventStaff.staffMemberId, role: eventStaff.role })
      .from(eventStaff)
      .innerJoin(event, eq(event.id, eventStaff.eventId))
      .where(eq(event.dayId, dayId))
      .all();
    return members
      .map((m) => ({
        staffMemberId: m.staffMemberId,
        events: roles.filter((r) => r.staffMemberId === m.staffMemberId).map((r) => ({ eventId: r.eventId, role: r.role })).sort((a, b) => a.eventId - b.eventId),
      }))
      .sort((a, b) => a.staffMemberId - b.staffMemberId);
  }

  function planInput(dayId: number): PlanInput {
    const day = dayRow(dayId);
    const entries = staffEntries(dayId);
    const people = new Map(directory.byIds(entries.map((e) => e.staffMemberId)).map((s) => [s.id, s]));
    return {
      day: { id: day.id, date: day.date, title: day.title },
      events: eventsOf(dayId).map((e) => ({ id: e.id, name: e.name, slug: e.slug, startsAt: e.startsAt, gameConfirmed: e.gameConfirmed })),
      staff: entries.map((e) => {
        const person = people.get(e.staffMemberId)!;
        return { staffMemberId: e.staffMemberId, discordUserId: person.discordUserId, linkState: person.linkState, events: e.events };
      }),
    };
  }

  const summary = (day: DayRow): DaySummary => ({
    id: day.id,
    date: day.date,
    title: day.title,
    state: day.state,
    season: day.season,
    eventCount: db.select({ n: sql<number>`count(*)` }).from(event).where(eq(event.dayId, day.id)).get()!.n,
    staffCount: db.select({ n: sql<number>`count(*)` }).from(dayStaff).where(eq(dayStaff.dayId, day.id)).get()!.n,
  });

  const eventView = (e: EventRow): EventView => ({
    id: e.id,
    name: e.name,
    slug: e.slug,
    game: e.game,
    gameConfirmed: e.gameConfirmed,
    startTime: localTimeOf(e.startsAt, timeZone),
    startsAt: e.startsAt,
    tournamentId: e.tournamentId,
    attendance:
      e.attendanceTournamentId === null
        ? null
        : { tournamentId: e.attendanceTournamentId, organizerPlayerId: e.attendanceOrganizerPlayerId, organizerName: e.attendanceOrganizerName },
  });

  const revocationPending = (d: DayRow) => d.revokePendingRevision !== null && (d.appliedRevision ?? 0) < d.revokePendingRevision;

  function plan(dayId: number): DayPlanCore {
    const day = dayRow(dayId);
    const entries = staffEntries(dayId);
    const people = new Map(directory.byIds(entries.map((e) => e.staffMemberId)).map((s) => [s.id, s]));
    return {
      day: {
        ...summary(day),
        blueprintId: day.blueprintId,
        categoryId: day.categoryId,
        attendance: { source: day.source, refreshedAt: day.attendanceRefreshedAt },
      },
      events: eventsOf(dayId).map(eventView),
      staff: entries
        .map((e) => {
          const person = people.get(e.staffMemberId)!;
          return { staffMemberId: e.staffMemberId, displayName: person.displayName, linkState: person.linkState, discordUserId: person.discordUserId, events: e.events };
        })
        .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.staffMemberId - b.staffMemberId),
      sync: { inSync: day.appliedRevision === day.planRevision, planRevision: day.planRevision, appliedRevision: day.appliedRevision, revocationPending: revocationPending(day) },
    };
  }

  // ---- writes

  const requireDraft = (day: DayRow) => {
    if (day.state !== 'draft') throw new ServiceError(409, 'day_not_draft', 'Only a day that hasn’t been opened can be changed this way.');
  };

  /** Bumps the plan revision; a removal on an open day also marks the revocation and queues a sync. */
  function bump(dayId: number, removal: boolean): number | null {
    const now = clock.now();
    db.update(eventDay).set({ planRevision: sql`${eventDay.planRevision} + 1`, updatedAt: now }).where(eq(eventDay.id, dayId)).run();
    const day = dayRow(dayId);
    if (!removal || day.state !== 'open') return null;
    db.update(eventDay)
      .set({ revokePendingRevision: day.planRevision, revokePendingAt: revocationPending(day) ? day.revokePendingAt : now })
      .where(eq(eventDay.id, dayId))
      .run();
    const jobId = enqueueSync(dayId);
    logger.info('Access removed: sync queued.', { dayId, jobId });
    return jobId;
  }

  function desiredFor(dayId: number) {
    const b = blueprintRows(dayRow(dayId).blueprintId)!;
    return desiredChannels(planInput(dayId), b, REMOVAL_CTX);
  }

  function writeBlueprint(id: number | null, input: BlueprintInput): number {
    const problems = validateBlueprint(input);
    if (problems.length) throw new ServiceError(422, 'invalid_blueprint', 'The blueprint breaks the audience rules.', { problems });
    const clash = db.select({ id: blueprint.id }).from(blueprint).where(eq(blueprint.name, input.name)).get();
    if (clash && clash.id !== id) throw new ServiceError(409, 'name_taken', 'Another blueprint has that name.');
    const now = clock.now();
    let bpId = id;
    if (bpId === null) {
      bpId = db.insert(blueprint).values({ name: input.name, categoryNamePattern: input.categoryNamePattern, createdAt: now, updatedAt: now }).returning({ id: blueprint.id }).get().id;
    } else {
      db.update(blueprint).set({ name: input.name, categoryNamePattern: input.categoryNamePattern, updatedAt: now }).where(eq(blueprint.id, bpId)).run();
      db.delete(blueprintChannel).where(eq(blueprintChannel.blueprintId, bpId)).run();
    }
    for (const c of input.channels) db.insert(blueprintChannel).values({ ...c, blueprintId: bpId }).run();
    return bpId;
  }

  const requireBlueprint = (id: number) => {
    if (!db.select({ id: blueprint.id }).from(blueprint).where(eq(blueprint.id, id)).get()) throw new ServiceError(422, 'unknown_blueprint', 'No such blueprint.');
  };

  function templateView(id: number): DayTemplate {
    const t = db.select().from(dayTemplate).where(eq(dayTemplate.id, id)).get();
    if (!t) throw notFound('template');
    const events = db.select().from(dayTemplateEvent).where(eq(dayTemplateEvent.templateId, id)).orderBy(asc(dayTemplateEvent.position)).all();
    return { id: t.id, name: t.name, blueprintId: t.blueprintId, events: events.map((e) => ({ name: e.name, game: e.game, startTime: e.startTime })) };
  }

  function writeTemplate(id: number | null, input: Omit<DayTemplate, 'id'>): number {
    requireBlueprint(input.blueprintId);
    const clash = db.select({ id: dayTemplate.id }).from(dayTemplate).where(eq(dayTemplate.name, input.name)).get();
    if (clash && clash.id !== id) throw new ServiceError(409, 'name_taken', 'Another template has that name.');
    const now = clock.now();
    let tId = id;
    if (tId === null) {
      tId = db.insert(dayTemplate).values({ name: input.name, blueprintId: input.blueprintId, createdAt: now, updatedAt: now }).returning({ id: dayTemplate.id }).get().id;
    } else {
      templateView(tId);
      db.update(dayTemplate).set({ name: input.name, blueprintId: input.blueprintId, updatedAt: now }).where(eq(dayTemplate.id, tId)).run();
      db.delete(dayTemplateEvent).where(eq(dayTemplateEvent.templateId, tId)).run();
    }
    input.events.forEach((e, position) => db.insert(dayTemplateEvent).values({ templateId: tId!, ...e, position }).run());
    return tId;
  }

  function insertEvent(day: DayRow, input: { name: string; game: Game; startTime: string; slug?: string; tournamentId?: string | null }): EventRow {
    const taken = eventsOf(day.id).map((e) => e.slug);
    if (input.slug && taken.includes(input.slug)) throw new ServiceError(409, 'slug_taken', 'Another event of this day has that slug.');
    return db
      .insert(event)
      .values({
        dayId: day.id,
        name: input.name.trim(),
        slug: input.slug ?? deriveSlug(input.name, taken),
        game: input.game,
        gameConfirmed: true,
        startsAt: zonedInstant(day.date, input.startTime, timeZone),
        tournamentId: input.tournamentId ?? null,
        position: taken.length,
      })
      .returning()
      .get();
  }

  const isDayHeadJudgeOf = (dayId: number, userId: string, holdsHeadJudgeRole: boolean): boolean => {
    const person = directory.byDiscordUser(userId);
    if (!person) return false;
    const entry = staffEntries(dayId).find((e) => e.staffMemberId === person.id);
    return entry !== undefined && (entry.events.some((e) => e.role === 'headjudge') || holdsHeadJudgeRole);
  };
  const liveDays = () => db.select().from(eventDay).where(ne(eventDay.state, 'purged')).orderBy(desc(eventDay.date), desc(eventDay.id)).all();

  return {
    // blueprints
    listBlueprints(): Blueprint[] {
      return db.select({ id: blueprint.id }).from(blueprint).orderBy(asc(blueprint.name)).all().map((b) => blueprintRows(b.id)!);
    },
    blueprint(id: number): Blueprint {
      return blueprintRows(id) ?? (() => {
        throw notFound('blueprint');
      })();
    },
    createBlueprint(input: BlueprintInput): Blueprint {
      return db.transaction(() => blueprintRows(writeBlueprint(null, input))!);
    },
    putBlueprint(id: number, input: BlueprintInput): Blueprint {
      return db.transaction(() => {
        if (!blueprintRows(id)) throw notFound('blueprint');
        const opened = db.select({ id: eventDay.id }).from(eventDay).where(and(eq(eventDay.blueprintId, id), ne(eventDay.state, 'draft'))).get();
        if (opened) throw new ServiceError(409, 'blueprint_in_use', 'A day using this blueprint has been opened: save a copy instead.');
        writeBlueprint(id, input);
        const drafts = db.select({ id: eventDay.id }).from(eventDay).where(eq(eventDay.blueprintId, id)).all();
        for (const d of drafts) bump(d.id, false);
        return blueprintRows(id)!;
      });
    },
    deleteBlueprint(id: number): void {
      db.transaction(() => {
        const b = blueprintRows(id);
        if (!b) throw notFound('blueprint');
        if (b.isDefault || b.inUse) throw new ServiceError(409, 'blueprint_in_use', 'The default blueprint, and any a day or template uses, can’t be deleted.');
        db.delete(blueprint).where(eq(blueprint.id, id)).run();
      });
    },

    // templates
    listTemplates(): DayTemplate[] {
      return db.select({ id: dayTemplate.id }).from(dayTemplate).orderBy(asc(dayTemplate.name)).all().map((t) => templateView(t.id));
    },
    createTemplate(input: Omit<DayTemplate, 'id'>): DayTemplate {
      return db.transaction(() => templateView(writeTemplate(null, input)));
    },
    putTemplate(id: number, input: Omit<DayTemplate, 'id'>): DayTemplate {
      return db.transaction(() => templateView(writeTemplate(id, input)));
    },
    deleteTemplate(id: number): void {
      templateView(id);
      db.delete(dayTemplate).where(eq(dayTemplate.id, id)).run();
    },

    // days
    listDays(): DaySummary[] {
      return db.select().from(eventDay).orderBy(desc(eventDay.date), desc(eventDay.id)).all().map(summary);
    },
    createDay(input: { date: string; title: string; blueprintId?: number; templateId?: number }): DayPlanCore {
      const guild = guildId();
      if (!guild) throw new ServiceError(409, 'setup_incomplete', 'Finish setup first.');
      return db.transaction(() => {
        let template: DayTemplate | null = null;
        if (input.templateId !== undefined) {
          const exists = db.select({ id: dayTemplate.id }).from(dayTemplate).where(eq(dayTemplate.id, input.templateId)).get();
          if (!exists) throw new ServiceError(422, 'unknown_template', 'No such template.');
          template = templateView(input.templateId);
        }
        const blueprintId = template?.blueprintId ?? input.blueprintId ?? db.select({ id: blueprint.id }).from(blueprint).where(eq(blueprint.isDefault, true)).get()!.id;
        requireBlueprint(blueprintId);
        const now = clock.now();
        const day = db
          .insert(eventDay)
          .values({ guildId: guild, date: input.date, title: input.title.trim(), blueprintId, season: currentSeason(), createdAt: now, updatedAt: now })
          .returning()
          .get();
        for (const e of template?.events ?? []) insertEvent(day, e);
        logger.info('Day created.', { dayId: day.id });
        return plan(day.id);
      });
    },
    plan,
    planInput,
    patchDay(dayId: number, patch: { title?: string; date?: string; blueprintId?: number }): DayPlanCore {
      return db.transaction(() => {
        const day = dayRow(dayId);
        const changes: Partial<DayRow> = {};
        if (patch.blueprintId !== undefined && patch.blueprintId !== day.blueprintId) {
          requireDraft(day);
          requireBlueprint(patch.blueprintId);
          changes.blueprintId = patch.blueprintId;
        }
        if (patch.title !== undefined) changes.title = patch.title.trim();
        if (patch.date !== undefined && patch.date !== day.date) {
          changes.date = patch.date;
          // Each event keeps its local start time on the new date.
          for (const e of eventsOf(dayId)) {
            db.update(event).set({ startsAt: zonedInstant(patch.date, localTimeOf(e.startsAt, timeZone), timeZone) }).where(eq(event.id, e.id)).run();
          }
        }
        if (Object.keys(changes).length) {
          db.update(eventDay).set(changes).where(eq(eventDay.id, dayId)).run();
          bump(dayId, false);
        }
        return plan(dayId);
      });
    },
    deleteDay(dayId: number): void {
      db.transaction(() => {
        requireDraft(dayRow(dayId));
        db.delete(eventDay).where(eq(eventDay.id, dayId)).run();
      });
    },

    // events
    addEvent(dayId: number, input: { name: string; game: Game; startTime: string; slug?: string; tournamentId?: string | null }): EventView {
      return db.transaction(() => {
        const created = insertEvent(dayRow(dayId), input);
        bump(dayId, false);
        return eventView(created);
      });
    },
    patchEvent(dayId: number, eventId: number, patch: { name?: string; game?: Game; startTime?: string; slug?: string; tournamentId?: string | null }): EventView {
      return db.transaction(() => {
        const day = dayRow(dayId);
        const current = db.select().from(event).where(and(eq(event.id, eventId), eq(event.dayId, dayId))).get();
        if (!current) throw notFound('event');
        if (patch.slug !== undefined && patch.slug !== current.slug && eventsOf(dayId).some((e) => e.slug === patch.slug)) {
          throw new ServiceError(409, 'slug_taken', 'Another event of this day has that slug.');
        }
        const changes: Partial<EventRow> = {};
        if (patch.name !== undefined) changes.name = patch.name.trim();
        // Setting the game confirms it, even unchanged: that is how an imported `other` is confirmed (§4.2).
        if (patch.game !== undefined) Object.assign(changes, { game: patch.game, gameConfirmed: true });
        if (patch.slug !== undefined) changes.slug = patch.slug;
        if (patch.tournamentId !== undefined) changes.tournamentId = patch.tournamentId;
        if (patch.startTime !== undefined) changes.startsAt = zonedInstant(day.date, patch.startTime, timeZone);
        if (Object.keys(changes).length) {
          db.update(event).set(changes).where(eq(event.id, eventId)).run();
          bump(dayId, false);
        }
        return eventView(db.select().from(event).where(eq(event.id, eventId)).get()!);
      });
    },
    deleteEvent(dayId: number, eventId: number): void {
      db.transaction(() => {
        requireDraft(dayRow(dayId));
        const current = db.select().from(event).where(and(eq(event.id, eventId), eq(event.dayId, dayId))).get();
        if (!current) throw notFound('event');
        db.delete(event).where(eq(event.id, eventId)).run();
        bump(dayId, false);
      });
    },

    // staff
    putStaff(dayId: number, staff: StaffEntry[]): { diff: StaffDiff; syncJobId: number | null; plan: DayPlanCore } {
      return db.transaction(() => {
        dayRow(dayId);
        const eventIds = new Set(eventsOf(dayId).map((e) => e.id));
        const ids = staff.map((s) => s.staffMemberId);
        const known = new Set(directory.byIds(ids).map((s) => s.id));
        const invalid =
          new Set(ids).size !== ids.length ||
          ids.some((id) => !known.has(id)) ||
          staff.some((s) => s.events.some((e) => !eventIds.has(e.eventId)) || new Set(s.events.map((e) => e.eventId)).size !== s.events.length);
        if (invalid) throw new ServiceError(422, 'invalid_staff', 'Each staff member once, with at most one role per event of this day.');

        const before = staffEntries(dayId);
        const desiredBefore = desiredFor(dayId);
        // A full replace keeps the imported flags of what survives it unchanged: a refresh may only take back what it
        // brought. A role the organizer changed by hand is theirs from then on.
        const importedDay = new Set(
          db.select().from(dayStaff).where(and(eq(dayStaff.dayId, dayId), eq(dayStaff.imported, true))).all().map((r) => r.staffMemberId),
        );
        const importedRoles = new Map(
          db
            .select({ eventId: eventStaff.eventId, staffMemberId: eventStaff.staffMemberId, role: eventStaff.role })
            .from(eventStaff)
            .where(and(inArray(eventStaff.eventId, [...eventIds, -1]), eq(eventStaff.imported, true)))
            .all()
            .map((r) => [`${r.eventId}:${r.staffMemberId}`, r.role]),
        );
        db.delete(eventStaff).where(inArray(eventStaff.eventId, [...eventIds, -1])).run();
        db.delete(dayStaff).where(eq(dayStaff.dayId, dayId)).run();
        for (const s of staff) {
          db.insert(dayStaff).values({ dayId, staffMemberId: s.staffMemberId, imported: importedDay.has(s.staffMemberId) }).run();
          for (const e of s.events) {
            const imported = importedRoles.get(`${e.eventId}:${s.staffMemberId}`) === e.role;
            db.insert(eventStaff).values({ eventId: e.eventId, staffMemberId: s.staffMemberId, role: e.role, imported }).run();
          }
        }

        const diff = diffStaff(before, staff);
        const removal = revokesAccess(desiredBefore, desiredFor(dayId));
        const syncJobId = bump(dayId, removal);
        return { diff, syncJobId, plan: plan(dayId) };
      });
    },

    // attendance import (§4.2)
    importState(dayId: number): ImportStateView {
      const day = dayRow(dayId);
      const events = eventsOf(dayId);
      const eventIds = [...events.map((e) => e.id), -1];
      const members = db.select().from(dayStaff).where(eq(dayStaff.dayId, dayId)).all();
      const roles = db.select().from(eventStaff).where(inArray(eventStaff.eventId, eventIds)).all();
      const people = new Map(directory.byIds(members.map((m) => m.staffMemberId)).map((s) => [s.id, s]));
      return {
        dayState: day.state,
        planRevision: day.planRevision,
        events: events.map((e) => ({
          id: e.id,
          name: e.name,
          startsAt: e.startsAt,
          game: e.game,
          gameConfirmed: e.gameConfirmed,
          tournamentId: e.tournamentId,
          attendanceTournamentId: e.attendanceTournamentId,
          organizerPlayerId: e.attendanceOrganizerPlayerId,
          organizerName: e.attendanceOrganizerName,
        })),
        staff: members
          .map((m) => {
            const person = people.get(m.staffMemberId)!;
            return {
              staffMemberId: m.staffMemberId,
              displayName: person.displayName,
              playerId: person.playerId,
              dayImported: m.imported,
              roles: roles
                .filter((r) => r.staffMemberId === m.staffMemberId)
                .map((r) => ({ eventId: r.eventId, role: r.role, imported: r.imported }))
                .sort((a, b) => a.eventId - b.eventId),
            };
          })
          .sort((a, b) => a.staffMemberId - b.staffMemberId),
      };
    },

    /**
     * Applies an accepted import in one transaction. Staff an import brings are flagged `imported`; an imported day
     * staffer who held a role before and holds none after leaves the day. With any change the revision is bumped
     * once, and a change that takes access away on an open day queues a sync at once (ADR-0005).
     */
    applyImport(dayId: number, ops: ImportOps): { syncJobId: number | null } {
      return db.transaction(() => {
        const day = dayRow(dayId);
        if (day.state !== 'draft' && day.state !== 'open') throw new ServiceError(409, 'day_not_editable', 'Only a day that isn’t closing or closed can be imported into.');
        const desiredBefore = desiredFor(dayId);
        const rolesBefore = new Set(staffEntries(dayId).filter((s) => s.events.length > 0).map((s) => s.staffMemberId));
        const onDay = new Set(db.select().from(dayStaff).where(eq(dayStaff.dayId, dayId)).all().map((r) => r.staffMemberId));
        const changed =
          ops.createEvents.length + ops.deleteEvents.length + ops.retireEvents.length + ops.changeEvents.length + ops.addRoles.length + ops.removeRoles.length + ops.changeRoles.length >
          0;

        const addRole = (eventId: number, staffMemberId: number, role: EventRole) => {
          if (!onDay.has(staffMemberId)) {
            db.insert(dayStaff).values({ dayId, staffMemberId, imported: true }).run();
            onDay.add(staffMemberId);
          }
          db.insert(eventStaff).values({ eventId, staffMemberId, role, imported: true }).run();
        };

        for (const e of ops.createEvents) {
          const taken = eventsOf(dayId).map((x) => x.slug);
          const created = db
            .insert(event)
            .values({
              dayId,
              name: e.name,
              slug: deriveSlug(e.name, taken),
              game: e.game,
              gameConfirmed: e.gameConfirmed,
              startsAt: e.startsAt,
              tournamentId: e.tournamentId,
              position: taken.length,
              attendanceTournamentId: e.attendanceTournamentId,
              attendanceOrganizerPlayerId: e.organizer.playerId,
              attendanceOrganizerName: e.organizer.name,
            })
            .returning()
            .get();
          for (const s of e.staff) addRole(created.id, s.staffMemberId, s.role);
        }
        for (const r of ops.addRoles) addRole(r.eventId, r.staffMemberId, r.role);
        for (const r of ops.changeRoles) {
          db.update(eventStaff).set({ role: r.role }).where(and(eq(eventStaff.eventId, r.eventId), eq(eventStaff.staffMemberId, r.staffMemberId))).run();
        }
        for (const r of ops.removeRoles) {
          db.delete(eventStaff).where(and(eq(eventStaff.eventId, r.eventId), eq(eventStaff.staffMemberId, r.staffMemberId))).run();
        }
        for (const c of ops.changeEvents) {
          const changes: Partial<EventRow> = {};
          if (c.name !== undefined) changes.name = c.name;
          if (c.startsAt !== undefined) changes.startsAt = c.startsAt;
          if (c.tournamentId !== undefined) changes.tournamentId = c.tournamentId;
          if (c.game !== undefined) Object.assign(changes, { game: c.game, gameConfirmed: true });
          db.update(event).set(changes).where(and(eq(event.id, c.eventId), eq(event.dayId, dayId))).run();
        }
        for (const id of ops.retireEvents) {
          db.delete(eventStaff).where(eq(eventStaff.eventId, id)).run();
          db.update(event)
            .set({ attendanceTournamentId: null, attendanceOrganizerPlayerId: null, attendanceOrganizerName: null })
            .where(and(eq(event.id, id), eq(event.dayId, dayId)))
            .run();
        }
        for (const id of ops.deleteEvents) db.delete(event).where(and(eq(event.id, id), eq(event.dayId, dayId))).run();
        for (const o of ops.organizers) {
          db.update(event)
            .set({ attendanceOrganizerPlayerId: o.playerId, attendanceOrganizerName: o.name })
            .where(and(eq(event.id, o.eventId), eq(event.dayId, dayId)))
            .run();
        }

        // An imported day staffer whose last role this import ended leaves the day; one added by hand never does.
        const holding = new Set(staffEntries(dayId).filter((s) => s.events.length > 0).map((s) => s.staffMemberId));
        const leaving = db
          .select()
          .from(dayStaff)
          .where(and(eq(dayStaff.dayId, dayId), eq(dayStaff.imported, true)))
          .all()
          .filter((r) => rolesBefore.has(r.staffMemberId) && !holding.has(r.staffMemberId))
          .map((r) => r.staffMemberId);
        if (leaving.length) db.delete(dayStaff).where(and(eq(dayStaff.dayId, dayId), inArray(dayStaff.staffMemberId, leaving))).run();

        db.update(eventDay).set({ source: 'attendance', attendanceRefreshedAt: ops.refreshedAt, updatedAt: clock.now() }).where(eq(eventDay.id, dayId)).run();
        if (!changed) return { syncJobId: null };
        const removal = revokesAccess(desiredBefore, desiredFor(dayId));
        return { syncJobId: bump(dayId, removal) };
      });
    },

    // hooks for other modules
    /** The directory's `onLinkChanged`: an unlink or relink on an open day is a removal. */
    onLinkChanged(staffMemberId: number): number[] {
      const rows = db
        .select({ dayId: dayStaff.dayId, state: eventDay.state })
        .from(dayStaff)
        .innerJoin(eventDay, eq(eventDay.id, dayStaff.dayId))
        .where(eq(dayStaff.staffMemberId, staffMemberId))
        .all();
      const jobIds: number[] = [];
      for (const r of rows) {
        const jobId = bump(r.dayId, true);
        if (jobId !== null) jobIds.push(jobId);
      }
      return jobIds;
    },
    /** The day an event belongs to. */
    dayOfEvent(eventId: number): number {
      const row = db.select({ dayId: event.dayId }).from(event).where(eq(event.id, eventId)).get();
      if (!row) throw notFound('event');
      return row.dayId;
    },
    isReferenced(staffMemberId: number): boolean {
      return db.select({ dayId: dayStaff.dayId }).from(dayStaff).where(eq(dayStaff.staffMemberId, staffMemberId)).get() !== undefined;
    },
    dayHeadJudge(userId: string, holdsHeadJudgeRole: boolean): boolean {
      return liveDays().some((d) => isDayHeadJudgeOf(d.id, userId, holdsHeadJudgeRole));
    },
    headJudgeDays(userId: string, holdsHeadJudgeRole: boolean): DaySummary[] {
      return liveDays()
        .filter((d) => isDayHeadJudgeOf(d.id, userId, holdsHeadJudgeRole))
        .map(summary);
    },
    alarms(): Alarm[] {
      return db
        .select()
        .from(eventDay)
        .where(and(eq(eventDay.state, 'open'), isNotNull(eventDay.revokePendingRevision)))
        .orderBy(asc(eventDay.id))
        .all()
        .filter(revocationPending)
        // `revoke_pending_at` is set whenever a revocation is pending (bump).
        .map((d) => ({ kind: 'access_not_revoked' as const, dayId: d.id, title: d.title, since: d.revokePendingAt! }));
    },
    /** Open days whose removals may not have landed, for boot recovery. */
    daysNeedingRevocation(): number[] {
      return db
        .select()
        .from(eventDay)
        .where(eq(eventDay.state, 'open'))
        .orderBy(asc(eventDay.id))
        .all()
        .filter((d) => d.appliedRevision === null || revocationPending(d))
        .map((d) => d.id);
    },
    /** Opens a draft day and queues its provision job in one transaction. */
    openDay(dayId: number, enqueueProvision: () => number): number {
      return db.transaction(() => {
        const day = dayRow(dayId);
        requireDraft(day);
        db.update(eventDay).set({ state: 'open', openedAt: clock.now(), updatedAt: clock.now() }).where(eq(eventDay.id, dayId)).run();
        return enqueueProvision();
      });
    },
    /** Every category a day records, so a stray with the same name can be told apart. */
    recordedCategoryIds(): Set<string> {
      return new Set(db.select({ id: eventDay.categoryId }).from(eventDay).where(isNotNull(eventDay.categoryId)).all().map((r) => r.id!));
    },
    recordCategory(dayId: number, categoryId: string): void {
      db.update(eventDay).set({ categoryId, updatedAt: clock.now() }).where(eq(eventDay.id, dayId)).run();
    },
    /** The provisioning job applied revision `revision`: pending removals up to it have landed. */
    recordApplied(dayId: number, revision: number): void {
      db.transaction(() => {
        const day = dayRow(dayId);
        const cleared = day.revokePendingRevision !== null && day.revokePendingRevision <= revision;
        db.update(eventDay)
          .set({
            appliedRevision: Math.max(revision, day.appliedRevision ?? 0),
            ...(cleared ? { revokePendingRevision: null, revokePendingAt: null } : {}),
          })
          .where(eq(eventDay.id, dayId))
          .run();
      });
    },
    /** A plan change that isn't the organizer's edit (an adopted orphan). */
    touch(dayId: number): void {
      bump(dayId, false);
    },
  };
}

function diffStaff(before: StaffEntry[], after: StaffEntry[]): StaffDiff {
  const was = new Map(before.map((s) => [s.staffMemberId, s]));
  const now = new Map(after.map((s) => [s.staffMemberId, s]));
  const diff: StaffDiff = { added: [], removed: [], eventRolesAdded: [], eventRolesRemoved: [], eventRolesChanged: [] };
  for (const id of now.keys()) if (!was.has(id)) diff.added.push(id);
  for (const id of was.keys()) if (!now.has(id)) diff.removed.push(id);
  for (const s of after) {
    const old = new Map((was.get(s.staffMemberId)?.events ?? []).map((e) => [e.eventId, e.role]));
    for (const e of s.events) {
      const from = old.get(e.eventId);
      if (from === undefined) diff.eventRolesAdded.push({ staffMemberId: s.staffMemberId, eventId: e.eventId, role: e.role });
      else if (from !== e.role) diff.eventRolesChanged.push({ staffMemberId: s.staffMemberId, eventId: e.eventId, role: e.role, from });
    }
    const kept = new Set(s.events.map((e) => e.eventId));
    for (const [eventId, role] of old) if (!kept.has(eventId)) diff.eventRolesRemoved.push({ staffMemberId: s.staffMemberId, eventId, role });
  }
  for (const s of before) {
    if (now.has(s.staffMemberId)) continue;
    for (const e of s.events) diff.eventRolesRemoved.push({ staffMemberId: s.staffMemberId, eventId: e.eventId, role: e.role });
  }
  diff.added.sort((a, b) => a - b);
  diff.removed.sort((a, b) => a - b);
  return diff;
}

export type EventDaysService = ReturnType<typeof createEventDaysService>;
