import { describe, expect, it } from 'vitest';
import { addDays, isCalendarDate, isLocalTime, localTimeOf, zonedInstant } from './index';

const CHICAGO = 'America/Chicago';

describe('zonedInstant', () => {
  it('turns a store-TZ date and time into the instant', () => {
    expect(new Date(zonedInstant('2026-10-17', '10:00', CHICAGO)).toISOString()).toBe('2026-10-17T15:00:00.000Z');
    expect(new Date(zonedInstant('2026-12-05', '10:00', CHICAGO)).toISOString()).toBe('2026-12-05T16:00:00.000Z');
    expect(new Date(zonedInstant('2026-10-17', '10:00', 'UTC')).toISOString()).toBe('2026-10-17T10:00:00.000Z');
  });

  it('is right on both sides of the DST changes', () => {
    // 2026-11-01: clocks fall back at 02:00 CDT → 01:00 CST.
    expect(new Date(zonedInstant('2026-11-01', '00:30', CHICAGO)).toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(new Date(zonedInstant('2026-11-01', '10:00', CHICAGO)).toISOString()).toBe('2026-11-01T16:00:00.000Z');
    // 2026-03-08: clocks spring forward at 02:00 CST → 03:00 CDT; 02:30 doesn't exist and lands an hour later.
    expect(new Date(zonedInstant('2026-03-08', '10:00', CHICAGO)).toISOString()).toBe('2026-03-08T15:00:00.000Z');
    expect(localTimeOf(zonedInstant('2026-03-08', '02:30', CHICAGO), CHICAGO)).toBe('03:30');
  });

  it('round-trips through localTimeOf', () => {
    for (const t of ['00:00', '09:05', '13:30', '23:59']) expect(localTimeOf(zonedInstant('2026-10-17', t, CHICAGO), CHICAGO)).toBe(t);
  });
});

describe('date helpers', () => {
  it('validates calendar dates and local times', () => {
    expect(isCalendarDate('2026-10-17')).toBe(true);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('2026-1-7')).toBe(false);
    expect(isLocalTime('23:59')).toBe(true);
    expect(isLocalTime('24:00')).toBe(false);
    expect(isLocalTime('9:00')).toBe(false);
  });

  it('adds calendar days', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
});
