import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { PolledMessage } from '../../server/modules/attendance/port';

/**
 * Attendance publishes no recorded answer of its message poll, so this fixture is written by hand. The test validates
 * it against `ATTENDANCE_MESSAGES_V1` below, which is copied verbatim from attendance's
 * `shared/schemas/integrations.ts` at commit a206b29 (release v1.29.0). Update both together.
 */
export const MESSAGES_FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/attendance/integrations-v1-messages.json');
export const messagesFixture = (): unknown => JSON.parse(readFileSync(MESSAGES_FIXTURE_PATH, 'utf8')) as unknown;

/** The long poll's answer. Strict, like `AttendanceDayV1`: no topic, ref or sender ever reaches Genie. */
export const ATTENDANCE_MESSAGES_V1 = z.strictObject({
  messages: z.array(
    z.strictObject({
      id: z.number().int().positive(),
      playerId: z.string().min(1),
      text: z.string().min(1).max(1800),
      link: z.strictObject({ label: z.string().min(1).max(60), url: z.string().min(1) }).nullable(),
      expiresAt: z.iso.datetime(),
    }),
  ),
});

/** What every `AttendanceMessages` subject must hand out for the fixture. */
export const FIXTURE_MESSAGES: PolledMessage[] = [
  {
    kind: 'message',
    id: 41,
    playerId: '1234567',
    text: 'Olive Oak invited you to Cerulean League on play-tools attendance. The link works once and expires on 23 October.',
    link: { label: 'Accept the invite', url: 'https://attendance.example/invite/Zq3vR8cK1mN0pL5sT2wX9yB4' },
    expiresAt: Date.parse('2026-10-23T15:04:05.000Z'),
  },
  { kind: 'message', id: 42, playerId: '0000222', text: 'Olive Oak lent you Brock Cup (26-10-000002) until 26 October.', link: null, expiresAt: Date.parse('2026-10-26T05:00:00.000Z') },
];
