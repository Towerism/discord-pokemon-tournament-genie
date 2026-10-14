import type { Outcome } from '../s3/types.js';

/** Nearest-rank statistics over per-page latencies from an injected monotonic clock. */
export function pageStats(latenciesMs: number[]): { median: number; p95: number; total: number } {
  if (latenciesMs.length === 0) return { median: 0, p95: 0, total: 0 };
  const s = [...latenciesMs].sort((a, b) => a - b);
  const rank = (p: number) => s[Math.max(0, Math.ceil(p * s.length) - 1)]!;
  return { median: rank(0.5), p95: rank(0.95), total: s.reduce((a, b) => a + b, 0) };
}

/** A CDN URL's expiry from its `ex` parameter (hex Unix seconds), or null. */
export function cdnExpiry(url: string): Date | null {
  const ex = new URL(url).searchParams.get('ex');
  if (!ex || !/^[0-9a-f]+$/i.test(ex)) return null;
  return new Date(parseInt(ex, 16) * 1000);
}

export type ThreadKind =
  | 'public-active'
  | 'public-archived'
  | 'private-active-genie-member'
  | 'private-active-genie-not-member'
  | 'private-archived-genie-member';
export type SeededThread = { id: string; kind: ThreadKind };
export type ListingName = 'active' | 'archivedPublic' | 'archivedPrivate' | 'joinedArchivedPrivate';
export type ListingError = { status: number; code?: number };
export type Listing = string[] | { error: ListingError };

/** Which listings are able to return each kind of thread. */
const CAN_FIND: Record<ThreadKind, ListingName[]> = {
  'public-active': ['active'],
  'public-archived': ['archivedPublic'],
  'private-active-genie-member': ['active'],
  'private-active-genie-not-member': ['active'],
  'private-archived-genie-member': ['archivedPrivate', 'joinedArchivedPrivate'],
};

export type ThreadListingRow = { id: string; kind: ThreadKind; foundBy: ListingName[]; missed: boolean; undetermined?: true };
export type ThreadListingReport = { rows: ThreadListingRow[]; errors: Partial<Record<ListingName, ListingError>> };

/** A thread is `missed` only if a listing that should return it succeeded and didn't. */
export function threadListingReport(seeded: SeededThread[], listings: Partial<Record<ListingName, Listing>>): ThreadListingReport {
  const errors: ThreadListingReport['errors'] = {};
  const found = new Map<ListingName, Set<string>>();
  for (const [name, listing] of Object.entries(listings) as [ListingName, Listing][]) {
    if (Array.isArray(listing)) found.set(name, new Set(listing));
    else errors[name] = listing.error;
  }
  const rows = seeded.map((t): ThreadListingRow => {
    const foundBy = [...found].filter(([, ids]) => ids.has(t.id)).map(([name]) => name);
    const couldTell = CAN_FIND[t.kind].some((l) => found.has(l));
    return { id: t.id, kind: t.kind, foundBy, missed: foundBy.length === 0 && couldTell, ...(couldTell || foundBy.length ? {} : { undetermined: true as const }) };
  });
  return { rows, errors };
}

const GATEWAY_MESSAGE_CONTENT = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;

export function intentState(appFlags: number): 'on' | 'off' {
  return appFlags & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED) ? 'on' : 'off';
}

export type MessageKind = 'text' | 'attachment' | 'embed' | 'mention';
export type FetchedMessage = { content: string; attachments: unknown[]; embeds: unknown[]; components: unknown[] };
export type ContentProbeRow = {
  messageKind: MessageKind;
  intent: 'on' | 'off';
  contentPresent: boolean;
  attachmentsPresent: boolean;
  embedsPresent: boolean;
  componentsPresent: boolean;
  matchesDocumented: boolean;
};

/**
 * Discord documents that without the intent `content`, `attachments`, `embeds` and `components`
 * come back empty, except in messages that mention the app. With it, each kind carries its field.
 */
export function contentProbeRow(m: FetchedMessage, kind: MessageKind, intent: 'on' | 'off'): ContentProbeRow {
  const row = {
    messageKind: kind,
    intent,
    contentPresent: m.content.length > 0,
    attachmentsPresent: m.attachments.length > 0,
    embedsPresent: m.embeds.length > 0,
    componentsPresent: m.components.length > 0,
  };
  const anyPresent = row.contentPresent || row.attachmentsPresent || row.embedsPresent || row.componentsPresent;
  let matchesDocumented: boolean;
  if (kind === 'mention') matchesDocumented = row.contentPresent;
  else if (intent === 'off') matchesDocumented = !anyPresent;
  else if (kind === 'attachment') matchesDocumented = row.attachmentsPresent;
  else if (kind === 'embed') matchesDocumented = row.embedsPresent;
  else matchesDocumented = row.contentPresent;
  return { ...row, matchesDocumented };
}

export const ATTACHMENT_SIZES: number[] = [
  1024,
  1_048_576,
  ...Array.from({ length: 20 }, () => 3_145_728),
  8_388_608,
  10_485_760,
  10_485_761,
];

export type SeedPlan = {
  perChannel: number[];
  authors: ('arranger' | 'probe-a' | 'probe-b')[];
  threads: { kind: ThreadKind; messages: number }[];
};

export const THREAD_MESSAGES = 20;

export function planSeed(o: { channels: number; messages: number }): SeedPlan {
  const base = Math.floor(o.messages / o.channels);
  const rest = o.messages % o.channels;
  return {
    perChannel: Array.from({ length: o.channels }, (_, i) => base + (i < rest ? 1 : 0)),
    authors: ['arranger', 'probe-a', 'probe-b'],
    threads: (
      [
        'public-active',
        'public-active',
        'public-archived',
        'private-active-genie-member',
        'private-active-genie-not-member',
        'private-archived-genie-member',
      ] as ThreadKind[]
    ).map((kind) => ({ kind, messages: THREAD_MESSAGES })),
  };
}

export type UploadRecord = { size: number; uploaded: boolean; status?: number; code?: number; error?: string };

export function recordUpload(size: number, outcome: Outcome): UploadRecord {
  if (outcome.kind === 'network') return { size, uploaded: false, error: outcome.message };
  const uploaded = outcome.status >= 200 && outcome.status < 300;
  return { size, uploaded, status: outcome.status, ...(outcome.code !== undefined ? { code: outcome.code } : {}) };
}
