import { describe, expect, it } from 'vitest';
import { newRunId, snowflakeMs } from '../../src/shared/ids.js';

describe('snowflakeMs', () => {
  it('decodes the Discord epoch timestamp', () => {
    // 175928847299117063 is Discord's documented example: 2016-04-30T11:18:25.796Z
    expect(new Date(snowflakeMs('175928847299117063')).toISOString()).toBe('2016-04-30T11:18:25.796Z');
  });
});

describe('newRunId', () => {
  const at = new Date('2026-10-13T12:00:00Z');

  it('is a UTC timestamp, a dash and four hex characters', () => {
    expect(newRunId(at, () => Uint8Array.from([0x0a, 0x1f]))).toBe('20261013120000-0a1f');
  });

  it('keeps the dash even when the hex part is all digits', () => {
    const id = newRunId(at, () => Uint8Array.from([0x12, 0x34]));
    expect(id).toBe('20261013120000-1234');
    expect(id).toMatch(/^\d{14}-[0-9a-f]{4}$/);
    expect(/\b\d{17,20}\b/.test(id)).toBe(false);
  });
});
