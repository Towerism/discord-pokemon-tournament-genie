import { LABEL_MAX, NOTES_MAX, ROUND_MAX, SEASON, SEVERITIES, VOID_REASON_MAX } from '../penalties';
import { z } from '../zod';

/** A Discord ID: a decimal snowflake. */
export const snowflake = z.string().regex(/^\d{17,20}$/, 'Expected a Discord ID.');

export const unlockBody = z.object({ code: z.string().min(1).max(64) });

export const discordBody = z.object({
  botToken: z.string().trim().min(20).max(200),
  clientId: snowflake,
  clientSecret: z.string().trim().min(8).max(200),
});

export const guildBody = z.object({ guildId: snowflake });

export const rolesBody = z.object({ organizerRoleId: snowflake, headJudgeRoleId: snowflake });

// ---- M2 (spec #17): every body of the directory, configuration and day routes.

const name64 = z.string().trim().min(1).max(64);
const playerId = z.string().regex(/^\d{1,10}$/, 'Player IDs are digits only.');
const id = z.number().int().positive();
const game = z.enum(['tcg', 'vgc', 'go', 'other']);
const eventRole = z.enum(['headjudge', 'judge', 'scorekeeper', 'administration', 'translator']);
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM.');
const calendarDate = z.string().refine((s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}, 'Expected a date like 2026-10-17.');
const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/, 'Lowercase letters, digits and dashes, up to 32.');
const tournamentId = z.string().regex(/^\d{2}-\d{2}-\d{6}$/, 'Expected a play-tools ID like 25-12-001050.');

export const staffCreateBody = z.strictObject({ displayName: name64, playerId: playerId.nullish(), discordUserId: snowflake.nullish() });
export const staffPatchBody = z.strictObject({ displayName: name64.optional(), playerId: playerId.nullable().optional(), discordUserId: snowflake.nullable().optional() });
export const memberQuery = z.object({ q: z.string().trim().min(1).max(32) });

const blueprintChannel = z.strictObject({
  key: z.string().min(1).max(32),
  scope: z.enum(['day', 'per_event']),
  kind: z.enum(['text', 'voice']),
  namePattern: z.string().trim().min(1).max(100),
  audience: z.enum(['all_staff', 'event_staff', 'head_judges']),
  purpose: z.enum(['general', 'floor', 'penalties']),
  topic: z.string().max(1024).nullable(),
  position: z.number().int().min(0).max(1000),
});
export const blueprintBody = z.strictObject({
  name: name64,
  categoryNamePattern: z.string().trim().min(1).max(100),
  channels: z.array(blueprintChannel).max(18),
});
export const templateBody = z.strictObject({
  name: name64,
  blueprintId: id,
  events: z.array(z.strictObject({ name: name64, game, startTime: localTime })).max(20),
});

export const dayCreateBody = z.strictObject({ date: calendarDate, title: name64, blueprintId: id.optional(), templateId: id.optional() });
export const dayPatchBody = z.strictObject({ title: name64.optional(), date: calendarDate.optional(), blueprintId: id.optional() });
export const eventCreateBody = z.strictObject({ name: name64, game, startTime: localTime, slug: slug.optional(), tournamentId: tournamentId.nullish() });
export const eventPatchBody = z.strictObject({ name: name64.optional(), game: game.optional(), startTime: localTime.optional(), slug: slug.optional(), tournamentId: tournamentId.nullable().optional() });
export const staffPutBody = z.strictObject({
  staff: z.array(z.strictObject({ staffMemberId: id, events: z.array(z.strictObject({ eventId: id, role: eventRole })).max(20) })).max(200),
});
export const adoptBody = z.strictObject({ key: z.string().min(1).max(32), eventId: id.nullable() });

export const allowlistBody = z.object({
  enabled: z.boolean(),
  userIds: z
    .array(snowflake)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Each user can be listed once.'),
});

// ---- M3 (spec #19): the attendance connection and the import.

/** An absolute http(s) address with no user, query or fragment: where attendance answers. */
function isAttendanceUrl(raw: string): boolean {
  if (raw.includes('?') || raw.includes('#')) return false;
  try {
    const url = new URL(raw);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

export const attendanceConnectionBody = z.strictObject({
  baseUrl: z.string().trim().max(2048).refine(isAttendanceUrl, 'Expected an http:// or https:// address without a user, query or fragment.'),
  token: z
    .string()
    .regex(/^ppa_int_[A-Za-z0-9_-]{43}$/, 'Expected an attendance integration token (ppa_int_…).')
    .optional(),
});

export const importAcceptBody = z.strictObject({
  snapshotId: z.uuid(),
  planRevision: z.number().int().min(1),
  keys: z.array(z.string().min(1).max(64)).max(2000),
});

// ---- M4 (spec #22): penalties, the catalog and the season.

const round = z.number().int().min(1).max(ROUND_MAX);
const severity = z.enum(SEVERITIES);
const notes = z.string().max(NOTES_MAX * 2).refine((s) => s.trim().length <= NOTES_MAX, `At most ${NOTES_MAX} characters.`);
const revision = z.number().int().min(1);
const season = z.string().regex(SEASON, 'Letters, digits, spaces, dots, dashes and underscores, up to 32.');

export const penaltyCreateBody = z.strictObject({
  idempotencyKey: z.uuidv4(),
  eventId: id,
  round,
  competitorPlayerId: playerId,
  categoryId: id,
  severity,
  penaltyTypeId: id,
  notes,
  judgeStaffMemberId: id,
});
export const penaltyPatchBody = z.strictObject({
  revision,
  round: round.optional(),
  competitorPlayerId: playerId.optional(),
  categoryId: id.optional(),
  severity: severity.optional(),
  penaltyTypeId: id.optional(),
  notes: notes.optional(),
  judgeStaffMemberId: id.optional(),
});
export const penaltyVoidBody = z.strictObject({ revision, reason: z.string().trim().min(1).max(VOID_REASON_MAX) });
export const emptyBody = z.strictObject({});
export const penaltyCsvQuery = z.strictObject({ eventId: z.coerce.number().int().positive(), voided: z.enum(['0', '1']).optional() });

const catalogRow = z.strictObject({
  id: id.optional(),
  label: z.string().trim().min(1).max(LABEL_MAX),
  games: z.array(game).min(1).max(4),
  rank: z.number().int().min(0).max(999),
  active: z.boolean(),
});
export const catalogPutBody = z.strictObject({ categories: z.array(catalogRow).max(200), types: z.array(catalogRow).max(200) });
export const catalogQuery = z.strictObject({ season: season.optional() });
export const seasonParam = season;
export const seasonPutBody = z.strictObject({ season, copyFrom: season.optional() });
