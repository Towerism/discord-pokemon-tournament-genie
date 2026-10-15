import { describe, expect, it } from 'vitest';
import { DAY_MS, DEFAULT_PURGE_GRACE_MS, contentDisposition, isNewer, parsePurgeGrace, purgeDecision, retentionDue, safeDownloadName, type PurgeFacts } from '.';

const facts = (over: Partial<PurgeFacts> = {}): PurgeFacts => ({
  exportSucceeded: true,
  files: [{ fileId: 1, name: 'lc-floor.json', check: 'ok' }],
  transcripts: [
    { channelId: '11', threadId: null, name: 'lc-floor', mark: '100', contentIntent: true, latest: '100' },
    { channelId: '11', threadId: '21', name: 'appeal', mark: '120', contentIntent: true, latest: '120' },
    { channelId: '12', threadId: null, name: 'day-staff', mark: null, contentIntent: true, latest: null },
  ],
  threadsNow: [{ channelId: '11', threadId: '21', name: 'appeal' }],
  presentChannels: [
    { channelId: '11', name: 'lc-floor' },
    { channelId: '12', name: 'day-staff' },
  ],
  skippedAttachments: 0,
  ...over,
});

describe('purgeDecision', () => {
  it('allows the purge when every condition holds', () => {
    expect(purgeDecision(facts())).toEqual({ allowed: true });
  });

  it('names each failing condition on its own', () => {
    const cases: [Partial<PurgeFacts>, unknown][] = [
      [{ exportSucceeded: false }, { code: 'no_export' }],
      [{ files: [{ fileId: 4, name: 'a.json', check: 'mismatch' }] }, { code: 'hash_mismatch', fileId: 4, name: 'a.json' }],
      [{ files: [{ fileId: 5, name: 'b.csv', check: 'missing' }] }, { code: 'file_missing', fileId: 5, name: 'b.csv' }],
      [{ transcripts: facts().transcripts.map((t, i) => (i === 2 ? { ...t, contentIntent: false } : t)) }, { code: 'content_intent_missing' }],
      [{ transcripts: facts().transcripts.map((t, i) => (i === 0 ? { ...t, latest: '101' } : t)) }, { code: 'newer_messages', channelId: '11', threadId: null, name: 'lc-floor' }],
      [{ transcripts: facts().transcripts.map((t, i) => (i === 1 ? { ...t, latest: '121' } : t)) }, { code: 'newer_messages', channelId: '11', threadId: '21', name: 'appeal' }],
      [{ threadsNow: [...facts().threadsNow, { channelId: '12', threadId: '22', name: 'late' }] }, { code: 'unexported_thread', channelId: '12', threadId: '22', name: 'late' }],
      [{ skippedAttachments: 3 }, { code: 'skipped_attachments', count: 3 }],
      [{ presentChannels: [...facts().presentChannels, { channelId: '13', name: 'vgc-floor' }] }, { code: 'unexported_channel', channelId: '13', name: 'vgc-floor' }],
    ];
    for (const [over, reason] of cases) expect(purgeDecision(facts(over)), JSON.stringify(reason)).toEqual({ allowed: false, reasons: [reason] });
  });

  it('names two failures together, and content intent once however many transcripts lack it', () => {
    const decision = purgeDecision(
      facts({ skippedAttachments: 1, transcripts: facts().transcripts.map((t) => ({ ...t, contentIntent: false })) }),
    );
    expect(decision).toEqual({ allowed: false, reasons: [{ code: 'content_intent_missing' }, { code: 'skipped_attachments', count: 1 }] });
  });

  it('beats a null mark with any message, and ignores a channel or thread that is gone', () => {
    const empty = facts({ transcripts: facts().transcripts.map((t, i) => (i === 2 ? { ...t, latest: '5' } : t)) });
    expect(purgeDecision(empty)).toEqual({ allowed: false, reasons: [{ code: 'newer_messages', channelId: '12', threadId: null, name: 'day-staff' }] });
    expect(purgeDecision(facts({ transcripts: facts().transcripts.map((t) => ({ ...t, latest: 'gone' as const })) }))).toEqual({ allowed: true });
  });
});

describe('isNewer', () => {
  it('compares snowflakes as numbers, not text', () => {
    expect(isNewer('100', '99')).toBe(true);
    expect(isNewer('99', '100')).toBe(false);
    expect(isNewer('100', '100')).toBe(false);
    expect(isNewer('1', null)).toBe(true);
    expect(isNewer(null, null)).toBe(false);
    expect(isNewer(null, '5')).toBe(false);
  });
});

describe('retentionDue', () => {
  const settings = { transcriptRetentionDays: 90, penaltyRetentionDays: 365 };
  const T = 1_000_000;
  const day = { closedAt: T, transcriptsSweptAt: null, penaltiesSweptAt: null };

  it('falls due at the boundary, not a millisecond before', () => {
    expect(retentionDue(day, settings, T + 90 * DAY_MS - 1)).toEqual({ transcripts: false, penalties: false });
    expect(retentionDue(day, settings, T + 90 * DAY_MS)).toEqual({ transcripts: true, penalties: false });
    expect(retentionDue(day, settings, T + 365 * DAY_MS)).toEqual({ transcripts: true, penalties: true });
  });

  it('is never due twice, nor for a day without a close time', () => {
    expect(retentionDue({ closedAt: T, transcriptsSweptAt: T + 1, penaltiesSweptAt: T + 2 }, settings, T + 999 * DAY_MS)).toEqual({ transcripts: false, penalties: false });
    expect(retentionDue({ ...day, closedAt: null }, settings, T + 999 * DAY_MS)).toEqual({ transcripts: false, penalties: false });
  });
});

describe('download names', () => {
  it('keeps a plain name and its extension', () => {
    expect(safeDownloadName('photo 1.png', 'attachment')).toBe('photo 1.png');
  });

  it('strips separators, quotes and control characters, and never leaves a dot file', () => {
    expect(safeDownloadName('../../evil".html', 'attachment')).toBe('evil.html');
    expect(safeDownloadName('a\\b/c\u0000d‮.txt', 'attachment')).toBe('cd.txt');
    expect(safeDownloadName('...', 'attachment')).toBe('attachment');
    expect(safeDownloadName('', 'attachment')).toBe('attachment');
  });

  it('caps the length at 100 and keeps the extension', () => {
    const name = safeDownloadName(`${'x'.repeat(300)}.pdf`, 'attachment');
    expect(name).toHaveLength(100);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('writes an ASCII filename and a UTF-8 one for the rest', () => {
    expect(contentDisposition('Pokémon notes.json')).toBe(`attachment; filename="Pok_mon notes.json"; filename*=UTF-8''Pok%C3%A9mon%20notes.json`);
    expect(contentDisposition('a.csv', 'inline')).toBe(`inline; filename="a.csv"; filename*=UTF-8''a.csv`);
  });
});

describe('parsePurgeGrace', () => {
  it('reads hours and days within 1 hour and 90 days, default 7 days', () => {
    expect(parsePurgeGrace(undefined)).toBe(DEFAULT_PURGE_GRACE_MS);
    expect(parsePurgeGrace('')).toBe(7 * DAY_MS);
    expect(parsePurgeGrace('7d')).toBe(604_800_000);
    expect(parsePurgeGrace('36h')).toBe(36 * 3_600_000);
    expect(parsePurgeGrace('1h')).toBe(3_600_000);
    expect(parsePurgeGrace('90d')).toBe(90 * DAY_MS);
  });

  it('refuses anything else, naming the variable', () => {
    for (const bad of ['0h', '91d', '7', '7 d', '-1h', '1.5d', '7w', 'd', '2161h']) {
      expect(() => parsePurgeGrace(bad), bad).toThrow(/GENIE_PURGE_GRACE/);
    }
  });
});
