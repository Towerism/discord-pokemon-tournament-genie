import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_SIZES,
  cdnExpiry,
  contentProbeRow,
  intentState,
  pageStats,
  planSeed,
  recordUpload,
  threadListingReport,
  type SeededThread,
} from '../../src/s4/analysis.js';

describe('pageStats', () => {
  it('reports median, nearest-rank p95 and total', () => {
    expect(pageStats([100, 200, 300, 400, 1000])).toEqual({ median: 300, p95: 1000, total: 2000 });
  });

  it('handles an empty channel', () => {
    expect(pageStats([])).toEqual({ median: 0, p95: 0, total: 0 });
  });

  it('is order-independent', () => {
    expect(pageStats([1000, 100, 400, 300, 200])).toEqual(pageStats([100, 200, 300, 400, 1000]));
  });
});

describe('cdnExpiry', () => {
  it('decodes the ex parameter as hex Unix seconds', () => {
    const url = 'https://cdn.discordapp.com/attachments/1/2/a.png?ex=6730a1b0&is=672f5030&hm=abc&';
    expect(cdnExpiry(url)?.toISOString()).toBe('2024-11-10T12:06:08.000Z');
  });

  it('is null without ex, or with a malformed one', () => {
    expect(cdnExpiry('https://cdn.discordapp.com/attachments/1/2/a.png')).toBeNull();
    expect(cdnExpiry('https://cdn.discordapp.com/a.png?ex=zz')).toBeNull();
  });
});

describe('threadListingReport', () => {
  const seeded: SeededThread[] = [
    { id: 't1', kind: 'public-active' },
    { id: 't2', kind: 'public-archived' },
    { id: 't3', kind: 'private-archived-genie-member' },
    { id: 't4', kind: 'private-active-genie-not-member' },
  ];

  it('shows which listing found each seeded thread and flags any nobody found', () => {
    const report = threadListingReport(seeded, {
      active: ['t1', 't4'],
      archivedPublic: ['t2'],
      archivedPrivate: ['t3'],
    });
    expect(report.rows).toEqual([
      { id: 't1', kind: 'public-active', foundBy: ['active'], missed: false },
      { id: 't2', kind: 'public-archived', foundBy: ['archivedPublic'], missed: false },
      { id: 't3', kind: 'private-archived-genie-member', foundBy: ['archivedPrivate'], missed: false },
      { id: 't4', kind: 'private-active-genie-not-member', foundBy: ['active'], missed: false },
    ]);
  });

  it('reports a failed listing as its error, not as threads missed', () => {
    const report = threadListingReport(seeded, {
      active: ['t1', 't4'],
      archivedPublic: ['t2'],
      archivedPrivate: { error: { status: 403, code: 50013 } },
      joinedArchivedPrivate: ['t3'],
    });
    expect(report.errors).toEqual({ archivedPrivate: { status: 403, code: 50013 } });
    expect(report.rows.find((r) => r.id === 't3')).toMatchObject({ foundBy: ['joinedArchivedPrivate'], missed: false });
  });

  it('flags a thread that every successful listing missed', () => {
    const report = threadListingReport(seeded, { active: ['t1'], archivedPublic: ['t2'], archivedPrivate: ['t3'] });
    expect(report.rows.find((r) => r.id === 't4')).toMatchObject({ foundBy: [], missed: true });
  });

  it('does not flag a thread missed when the only listing that could find it failed', () => {
    const report = threadListingReport([{ id: 't3', kind: 'private-archived-genie-member' }], {
      archivedPrivate: { error: { status: 403 } },
    });
    expect(report.rows[0]).toMatchObject({ foundBy: [], missed: false, undetermined: true });
  });
});

describe('intentState', () => {
  it.each([
    [0, 'off'],
    [1 << 18, 'on'],
    [1 << 19, 'on'],
    [(1 << 19) | (1 << 23), 'on'],
    [1 << 23, 'off'],
  ] as const)('flags %i → %s', (flags, state) => {
    expect(intentState(flags)).toBe(state);
  });
});

describe('contentProbeRow', () => {
  const empty = { content: '', attachments: [], embeds: [], components: [] };

  it('matches the documented behaviour when the intent is off and the fields are empty', () => {
    expect(contentProbeRow(empty, 'attachment', 'off')).toEqual({
      messageKind: 'attachment',
      intent: 'off',
      contentPresent: false,
      attachmentsPresent: false,
      embedsPresent: false,
      componentsPresent: false,
      matchesDocumented: true,
    });
  });

  it('does not match when the intent is on but a text message comes back empty', () => {
    expect(contentProbeRow(empty, 'text', 'on').matchesDocumented).toBe(false);
  });

  it('expects content on a message that mentions the app even with the intent off', () => {
    expect(contentProbeRow({ ...empty, content: '<@1> hi' }, 'mention', 'off').matchesDocumented).toBe(true);
    expect(contentProbeRow(empty, 'mention', 'off').matchesDocumented).toBe(false);
  });

  it('expects the kind\'s own field with the intent on', () => {
    expect(contentProbeRow({ ...empty, attachments: [{}] }, 'attachment', 'on').matchesDocumented).toBe(true);
    expect(contentProbeRow({ ...empty, embeds: [{}] }, 'embed', 'on').matchesDocumented).toBe(true);
    expect(contentProbeRow(empty, 'embed', 'on').matchesDocumented).toBe(false);
  });

  it('flags leaked fields with the intent off', () => {
    expect(contentProbeRow({ ...empty, content: 'hello' }, 'text', 'off').matchesDocumented).toBe(false);
  });
});

describe('planSeed', () => {
  it('spreads the messages evenly over the channels and the three authors', () => {
    const plan = planSeed({ channels: 4, messages: 2000 });
    expect(plan.perChannel).toEqual([500, 500, 500, 500]);
    expect(plan.authors).toEqual(['arranger', 'probe-a', 'probe-b']);
  });

  it('puts the remainder on the first channels', () => {
    expect(planSeed({ channels: 3, messages: 10 }).perChannel).toEqual([4, 3, 3]);
  });

  it('seeds the six threads with at least 20 messages each', () => {
    const plan = planSeed({ channels: 4, messages: 2000 });
    expect(plan.threads.map((t) => t.kind)).toEqual([
      'public-active',
      'public-active',
      'public-archived',
      'private-active-genie-member',
      'private-active-genie-not-member',
      'private-archived-genie-member',
    ]);
    expect(plan.threads.every((t) => t.messages >= 20)).toBe(true);
  });

  it('uploads the specified attachment sizes, with twenty 3 MiB phone photos', () => {
    expect(ATTACHMENT_SIZES.filter((s) => s === 3_145_728)).toHaveLength(20);
    expect(new Set(ATTACHMENT_SIZES)).toEqual(new Set([1024, 1_048_576, 3_145_728, 8_388_608, 10_485_760, 10_485_761]));
  });
});

describe('recordUpload', () => {
  it('records an upload the cap refuses with its size and code', () => {
    expect(recordUpload(10_485_761, { kind: 'http', status: 413, code: 40005 })).toEqual({
      size: 10_485_761,
      uploaded: false,
      status: 413,
      code: 40005,
    });
  });

  it('records a successful upload', () => {
    expect(recordUpload(1024, { kind: 'http', status: 200 })).toEqual({ size: 1024, uploaded: true, status: 200 });
  });

  it('records a network failure as not uploaded', () => {
    expect(recordUpload(1024, { kind: 'network', message: 'reset' })).toEqual({ size: 1024, uploaded: false, error: 'reset' });
  });
});
