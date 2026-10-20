import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAttendanceMessagesHttp } from '../../server/modules/attendance/adapters/http/messages';
import { createFakeAttendanceMessages } from '../../server/modules/attendance/fake';
import type { AttendanceMessages } from '../../server/modules/attendance/port';
import { ATTENDANCE_MESSAGES_V1, FIXTURE_MESSAGES, messagesFixture } from '../contract/attendance-messages';
import { type FakeAttendanceHttp, startFakeAttendanceHttp } from '../support/fake-attendance-http';

const TOKEN = `ppa_int_${'m'.repeat(43)}`;

let http: FakeAttendanceHttp;
beforeAll(async () => {
  http = await startFakeAttendanceHttp({ token: TOKEN });
});
afterAll(() => http.close());
beforeEach(() => {
  http.queue.length = 0;
  http.results.length = 0;
});

const poll = (subject: AttendanceMessages) => subject.poll({ waitSeconds: 25, limit: 20, signal: new AbortController().signal });

describe('the attendance message contract', () => {
  it('holds a fixture that attendance’s own schema accepts', () => {
    expect(ATTENDANCE_MESSAGES_V1.safeParse(messagesFixture()).success).toBe(true);
  });

  const subjects: { name: string; build: () => AttendanceMessages; delivered: () => { id: number; body: unknown }[] }[] = [
    (() => {
      const fake = createFakeAttendanceMessages();
      return {
        name: 'the in-memory fake',
        build: () => {
          fake.queue.push(...structuredClone(FIXTURE_MESSAGES));
          return fake;
        },
        delivered: () => fake.results,
      };
    })(),
    {
      name: 'the HTTP adapter against the HTTP fake',
      build: () => {
        http.queue.push(...(messagesFixture() as { messages: unknown[] }).messages);
        return createAttendanceMessagesHttp({ baseUrl: http.url, token: TOKEN, maxBytes: 256 * 1024 });
      },
      delivered: () => http.results,
    },
  ];

  for (const subject of subjects) {
    describe(subject.name, () => {
      it('hands out the fixture’s messages, then takes their results', async () => {
        const messages = subject.build();
        expect(await poll(messages)).toEqual(FIXTURE_MESSAGES);
        expect(await messages.report(41, { status: 'delivered' })).toBe('recorded');
        expect(await messages.report(42, { status: 'failed', reason: 'discord_unavailable' })).toBe('recorded');
        expect(subject.delivered()).toEqual([
          { id: 41, body: { status: 'delivered' } },
          { id: 42, body: { status: 'failed', reason: 'discord_unavailable' } },
        ]);
      });
    });
  }
});
