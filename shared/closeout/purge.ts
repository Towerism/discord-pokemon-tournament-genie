/**
 * The purge gate (§6.5 step 5, ADR-0007 decision 4), as a pure decision over facts the purge job gathers. Deleting
 * a channel can't be undone, so every condition names what fails it and the organizer can act on each one.
 */

export type RefusalReason =
  | { code: 'no_export' }
  | { code: 'hash_mismatch' | 'file_missing'; fileId: number; name: string }
  | { code: 'content_intent_missing' }
  | { code: 'newer_messages'; channelId: string; threadId: string | null; name: string }
  | { code: 'unexported_thread'; channelId: string; threadId: string; name: string }
  | { code: 'skipped_attachments'; count: number }
  | { code: 'unexported_channel'; channelId: string; name: string };

export interface PurgeFacts {
  /** The day has a succeeded export run. */
  exportSucceeded: boolean;
  /** Every current file, checked against its recorded SHA-256. */
  files: { fileId: number; name: string; check: 'ok' | 'missing' | 'mismatch' }[];
  /**
   * Every current transcript, with its mark and the newest message Discord holds now that isn't one of Genie's own
   * alert posts (`null`: none; `'gone'`: the channel or thread no longer exists).
   */
  transcripts: { channelId: string; threadId: string | null; name: string; mark: string | null; contentIntent: boolean; latest: string | null | 'gone' }[];
  /** The threads Discord lists now in the day's channels. */
  threadsNow: { channelId: string; threadId: string; name: string }[];
  /** The day's channels Genie still records as present. */
  presentChannels: { channelId: string; name: string }[];
  /** Current attachments still `skipped`. */
  skippedAttachments: number;
}

export type PurgeDecision = { allowed: true } | { allowed: false; reasons: RefusalReason[] };

/** Snowflakes order by number; `null` is older than every message. */
export function isNewer(id: string | null, than: string | null): boolean {
  if (id === null) return false;
  if (than === null) return true;
  return BigInt(id) > BigInt(than);
}

export function purgeDecision(facts: PurgeFacts): PurgeDecision {
  const reasons: RefusalReason[] = [];
  if (!facts.exportSucceeded) reasons.push({ code: 'no_export' });
  for (const f of facts.files) {
    if (f.check === 'missing') reasons.push({ code: 'file_missing', fileId: f.fileId, name: f.name });
    if (f.check === 'mismatch') reasons.push({ code: 'hash_mismatch', fileId: f.fileId, name: f.name });
  }
  if (facts.transcripts.some((t) => !t.contentIntent)) reasons.push({ code: 'content_intent_missing' });
  for (const t of facts.transcripts) {
    if (t.latest !== 'gone' && isNewer(t.latest, t.mark)) reasons.push({ code: 'newer_messages', channelId: t.channelId, threadId: t.threadId, name: t.name });
  }
  const exportedThreads = new Set(facts.transcripts.flatMap((t) => (t.threadId === null ? [] : [t.threadId])));
  for (const thread of facts.threadsNow) {
    if (!exportedThreads.has(thread.threadId)) reasons.push({ code: 'unexported_thread', channelId: thread.channelId, threadId: thread.threadId, name: thread.name });
  }
  if (facts.skippedAttachments > 0) reasons.push({ code: 'skipped_attachments', count: facts.skippedAttachments });
  const exportedChannels = new Set(facts.transcripts.filter((t) => t.threadId === null).map((t) => t.channelId));
  for (const channel of facts.presentChannels) {
    if (!exportedChannels.has(channel.channelId)) reasons.push({ code: 'unexported_channel', channelId: channel.channelId, name: channel.name });
  }
  return reasons.length ? { allowed: false, reasons } : { allowed: true };
}
