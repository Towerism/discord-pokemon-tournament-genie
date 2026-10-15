/**
 * The penalty CSV the head judge submits (§6.6, ADR-0006). The sample's columns, order and quoting are the contract,
 * guarded by a golden file. It is a submission artifact: labels and notes are written verbatim, never prefixed
 * against spreadsheet formulas.
 */
import type { Severity } from './index';

export const CSV_HEADER = "Tournament ID,Round of Issue,Judge Player ID,Competitor's Player ID,Category,Severity,Penalty,Notes";

export interface CsvPenalty {
  number: number;
  round: number;
  recordedAt: number;
  judgePlayerId: string;
  competitorPlayerId: string;
  category: string;
  severity: Severity;
  penaltyType: string;
  notes: string;
}

/** RFC 4180, as the sample: quoted only when the field holds a comma, a double quote or a line break. */
const field = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

/** One event's file: UTF-8 without BOM, LF line endings, ordered by round, then recording time, then number. */
export function penaltiesCsv(tournamentId: string, penalties: readonly CsvPenalty[]): string {
  const ordered = [...penalties].sort((a, b) => a.round - b.round || a.recordedAt - b.recordedAt || a.number - b.number);
  const lines = ordered.map((p) =>
    [tournamentId, String(p.round), p.judgePlayerId, p.competitorPlayerId, p.category, p.severity, p.penaltyType, p.notes].map(field).join(','),
  );
  return [CSV_HEADER, ...lines].join('\n') + '\n';
}
