/** Retention (§15 Q3, ADR-0007 decision 7), measured from the day's close. The caller passes only purged days. */

export const DAY_MS = 86_400_000;

export interface RetentionSettings {
  transcriptRetentionDays: number;
  penaltyRetentionDays: number;
}

export function retentionDue(
  day: { closedAt: number | null; transcriptsSweptAt: number | null; penaltiesSweptAt: number | null },
  settings: RetentionSettings,
  now: number,
): { transcripts: boolean; penalties: boolean } {
  if (day.closedAt === null) return { transcripts: false, penalties: false };
  return {
    transcripts: day.transcriptsSweptAt === null && day.closedAt + settings.transcriptRetentionDays * DAY_MS <= now,
    penalties: day.penaltiesSweptAt === null && day.closedAt + settings.penaltyRetentionDays * DAY_MS <= now,
  };
}
