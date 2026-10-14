import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAttendanceHttp } from '../../server/modules/attendance/adapters/http';
import { createFakeAttendance } from '../../server/modules/attendance/fake';
import type { AttendanceSource } from '../../server/modules/attendance/port';
import { ATTENDANCE_CONTRACT_CASES, RECORDED_FIXTURE_SHA256, recordedFixtureBytes, sha256 } from '../contract/attendance-source';
import { type FakeAttendanceHttp, startFakeAttendanceHttp, toWire } from '../support/fake-attendance-http';

const TOKEN = `ppa_int_${'a'.repeat(43)}`;

let http: FakeAttendanceHttp;
beforeAll(async () => {
  http = await startFakeAttendanceHttp({ token: TOKEN });
});
afterAll(() => http.close());

describe('the attendance contract', () => {
  it('reads the fixture attendance recorded, unchanged', () => {
    expect(sha256(recordedFixtureBytes())).toBe(RECORDED_FIXTURE_SHA256);
  });

  const subjects: { name: string; build: (c: (typeof ATTENDANCE_CONTRACT_CASES)[number]) => AttendanceSource }[] = [
    {
      name: 'the in-memory fake',
      build: (c) => {
        const fake = createFakeAttendance();
        fake.days.set(c.day.date, c.day);
        return fake;
      },
    },
    {
      name: 'the HTTP adapter against the HTTP fake',
      build: (c) => {
        http.raw.set(c.day.date, c.wire ?? toWire(c.day));
        return createAttendanceHttp({ baseUrl: http.url, token: TOKEN, timeoutMs: 5_000, maxBytes: 2 * 1024 * 1024 });
      },
    },
  ];

  for (const subject of subjects) {
    describe(subject.name, () => {
      for (const c of ATTENDANCE_CONTRACT_CASES) {
        it(c.name, async () => {
          expect(await subject.build(c).getDay(c.day.date)).toEqual(c.day);
        });
      }
    });
  }
});
