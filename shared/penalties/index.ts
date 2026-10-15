/**
 * Penalties as data (ADR-0006): what the catalog offers for an event, who may change a recorded penalty, and the
 * CSV. Pure: the bot, the routes and the service all decide through these, so Discord and the website agree.
 */
import { type AccessPlan, type Principal, canSee } from '../access/access';

export { type CsvPenalty, CSV_HEADER, penaltiesCsv } from './csv';

export const GAMES = ['tcg', 'vgc', 'go', 'other'] as const;
export type Game = (typeof GAMES)[number];
export const SEVERITIES = ['Minor', 'Major', 'Severe'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** The recording judge may edit their own penalty this long after recording it (§6.4), boundary included. */
export const EDIT_WINDOW_MS = 15 * 60_000;
/** A select holds 25 options; one stays free for the Edit modal's current choice when it is no longer offered. */
export const MAX_ACTIVE_OPTIONS = 24;
export const ROUND_MAX = 99;
export const NOTES_MAX = 1000;
export const VOID_REASON_MAX = 500;
export const LABEL_MAX = 100;
/** Play! Pokémon player IDs: digits only, leading zeros kept (the directory's rule). */
export const PLAYER_ID = /^\d{1,10}$/;
/** The play-tools display ID the CSV's first column needs (`25-12-001050`). */
export const TOURNAMENT_ID = /^\d{2}-\d{2}-\d{6}$/;

export interface CatalogRow {
  id: number;
  season: string;
  label: string;
  games: Game[];
  rank: number;
  active: boolean;
}

export interface Catalog {
  categories: readonly CatalogRow[];
  types: readonly CatalogRow[];
}

const byRank = (a: CatalogRow, b: CatalogRow) => a.rank - b.rank || a.id - b.id;

/** The only source of what `/penalty` and the website offer, and of what recording accepts. */
export function catalogOptions(catalog: Catalog, season: string, game: Game): { categories: CatalogRow[]; types: CatalogRow[] } {
  const offered = (rows: readonly CatalogRow[]) => rows.filter((r) => r.season === season && r.active && r.games.includes(game)).sort(byRank);
  return { categories: offered(catalog.categories), types: offered(catalog.types) };
}

export type EditRight = 'manage' | 'judge_window' | null;

/**
 * Who may change a recorded penalty, and nothing else: the penalty's and the day's state are the service's refusals.
 * `judge_window` allows Edit, never Void.
 */
export function editRight(
  penalty: { eventId: number; judgeDiscordUserId: string | null; recordedAt: number },
  caller: Principal | null,
  plan: AccessPlan,
  now: number,
): EditRight {
  if (canSee(caller, { kind: 'event_penalties', eventId: penalty.eventId, action: 'manage' }, plan)) return 'manage';
  const isJudge = caller !== null && penalty.judgeDiscordUserId !== null && caller.userId === penalty.judgeDiscordUserId;
  if (isJudge && canSee(caller, { kind: 'event_penalties', eventId: penalty.eventId, action: 'record' }, plan) && now - penalty.recordedAt <= EDIT_WINDOW_MS) {
    return 'judge_window';
  }
  return null;
}
