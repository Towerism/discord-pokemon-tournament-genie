import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { AttendanceDay } from '../../server/modules/attendance/port';

/** Attendance's recorded v1 answer (attendance #115, commit 01b2b58), copied verbatim. */
export const RECORDED_FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/attendance/integrations-v1-day.json');
export const RECORDED_FIXTURE_SHA256 = '1e161798598cfb13d6b39f1316b29caf107ff86d0bd794471105e43f58b5716c';

export const recordedFixtureBytes = () => readFileSync(RECORDED_FIXTURE_PATH);
export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export interface AttendanceContractCase {
  name: string;
  /** What every subject must answer for `day.date`. */
  day: AttendanceDay;
  /** The wire body the HTTP subject is served, when it isn't simply `day` sent as v1. */
  wire?: unknown;
}

const at = (iso: string) => Date.parse(iso);

/**
 * One table for every `AttendanceSource`: the in-memory fake and the HTTP adapter against the HTTP fake both answer each
 * case's `day`. The first case is attendance's own recorded answer.
 */
export const ATTENDANCE_CONTRACT_CASES: AttendanceContractCase[] = [
  {
    name: 'the recorded fixture: two read professors, one tournament each',
    wire: JSON.parse(recordedFixtureBytes().toString('utf8')) as unknown,
    day: {
      date: '2026-10-14',
      timeZone: 'America/Chicago',
      tournaments: [
        {
          id: 'brocks',
          name: 'Brock Cup',
          displayId: '26-10-000002',
          startsAt: at('2026-10-14T22:00:00.000Z'),
          game: 'vgc',
          organizer: { playerId: '0000222', name: 'Brock Harrison' },
          staff: [],
        },
        {
          id: 'olives',
          name: 'Olive Cup',
          displayId: '26-10-000001',
          startsAt: at('2026-10-14T23:30:00.000Z'),
          game: 'tcg',
          organizer: { playerId: '9999991', name: 'Olive Oak' },
          staff: [
            { playerId: '00888', name: 'Misty Waterflower', role: 'scorekeeper' },
            { playerId: '00777', name: 'Ash Ketchum', role: 'judge' },
          ],
        },
      ],
      professors: [
        { playerId: '9999991', name: 'Olive Oak', status: 'read' },
        { playerId: '0000222', name: 'Brock Harrison', status: 'read' },
      ],
    },
  },
  {
    name: 'unread professors, each reason',
    day: {
      date: '2026-10-17',
      timeZone: 'America/Chicago',
      tournaments: [
        {
          id: 'oak-1',
          name: 'Oak LC',
          displayId: '26-10-000010',
          startsAt: at('2026-10-17T15:00:00.000Z'),
          game: 'tcg',
          organizer: { playerId: '1000001', name: 'Prof. Oak' },
          staff: [{ playerId: '1234567', name: 'Ash K.', role: 'headjudge' }],
        },
      ],
      professors: [
        { playerId: '1000001', name: 'Prof. Oak', status: 'read' },
        { playerId: '1000002', name: 'Prof. Elm', status: 'unread', reason: 'needs_reconnect' },
        { playerId: '1000003', name: 'Prof. Birch', status: 'unread', reason: 'read_failed' },
      ],
    },
  },
  {
    name: 'an unread professor without a reason reads as read_failed',
    wire: {
      date: '2026-10-18',
      timezone: 'America/Chicago',
      tournaments: [],
      professors: [{ playerId: '1000002', name: 'Prof. Elm', status: 'unread' }],
    },
    day: {
      date: '2026-10-18',
      timeZone: 'America/Chicago',
      tournaments: [],
      professors: [{ playerId: '1000002', name: 'Prof. Elm', status: 'unread', reason: 'read_failed' }],
    },
  },
  {
    name: 'unknown game and display ID',
    day: {
      date: '2026-10-19',
      timeZone: 'America/Chicago',
      tournaments: [
        {
          id: 'elm-1',
          name: 'Elm Cup',
          displayId: null,
          startsAt: at('2026-10-19T18:00:00.000Z'),
          game: null,
          organizer: { playerId: '1000002', name: 'Prof. Elm' },
          staff: [],
        },
      ],
      professors: [{ playerId: '1000002', name: 'Prof. Elm', status: 'read' }],
    },
  },
  {
    name: 'no professor connected',
    day: { date: '2026-10-20', timeZone: 'America/Chicago', tournaments: [], professors: [] },
  },
  {
    name: 'a zone alias Node folds is answered by its canonical name',
    wire: { date: '2026-10-21', timezone: 'US/Central', tournaments: [], professors: [] },
    day: { date: '2026-10-21', timeZone: 'America/Chicago', tournaments: [], professors: [] },
  },
  {
    name: 'an extra field attendance may add later is ignored',
    wire: { date: '2026-10-22', timezone: 'America/Chicago', tournaments: [], professors: [], generatedAt: 'later' },
    day: { date: '2026-10-22', timeZone: 'America/Chicago', tournaments: [], professors: [] },
  },
];
