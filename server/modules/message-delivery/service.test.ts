import { type FakeClock, fakeClock } from '@towerism/selfhost-kit/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from '../../../test/support/db';
import { type FakeAttendanceHttp, startFakeAttendanceHttp } from '../../../test/support/fake-attendance-http';
import { type FakeScheduler, fakeScheduler } from '../../../test/support/fake-scheduler';
import { type LogRecord, recordingLogger } from '../../../test/support/logger';
import type { OpenDatabase } from '../../db/client';
import { deliveredMessage } from '../../db/schema';
import { createAttendanceMessagesHttp } from '../attendance/adapters/http/messages';
import { type DirectoryService, createDirectoryService } from '../directory';
import { type FakeDiscord, createFakeDiscord } from '../discord/fake';
import type { DiscordGateway } from '../discord/port';
import { type MessageDeliveryService, connectionKey, createMessageDeliveryService } from './index';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const TOKEN = `ppa_int_${'d'.repeat(43)}`;
const APP = '300000000000000001';
const BOT_TOKEN = 'fake-bot-token-delivery';
const GUILD = '400000000000000001';
const ASH = '100000000000000001';
const MISTY = '100000000000000002';
const SECRET_URL = 'https://attendance.example/invite/Zq3vR8cK1mN0pL5sT2wX9yB4';

const wire = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  playerId: '1234567',
  text: 'Olive Oak invited you to Cerulean League.',
  link: { label: 'Accept the invite', url: SECRET_URL },
  expiresAt: new Date(NOW + 72 * 3_600_000).toISOString(),
  ...extra,
});

let httpA: FakeAttendanceHttp;
let httpB: FakeAttendanceHttp;
beforeAll(async () => {
  [httpA, httpB] = await Promise.all([startFakeAttendanceHttp({ token: TOKEN }), startFakeAttendanceHttp({ token: TOKEN })]);
});
afterAll(() => Promise.all([httpA.close(), httpB.close()]));

let database: OpenDatabase;
let clock: FakeClock;
let scheduler: FakeScheduler;
let discord: FakeDiscord;
let gateway: DiscordGateway;
let directory: DirectoryService;
let records: LogRecord[];
let botConnected: boolean;
let botListeners: Set<(state: 'stopped' | 'connecting' | 'connected' | 'error') => void>;
let connection: { baseUrl: string; token: string } | null | 'unreadable';
let ready: boolean;
let service: MessageDeliveryService;

beforeEach(() => {
  httpA.resetMessages();
  httpB.resetMessages();
  database = freshDb();
  clock = fakeClock(NOW);
  scheduler = fakeScheduler(clock);
  discord = createFakeDiscord();
  discord.addApplication({ id: APP, token: BOT_TOKEN });
  discord.addGuild({ id: GUILD, name: 'Store' });
  discord.inviteBot(APP, GUILD);
  discord.addMember(GUILD, ASH);
  discord.addMember(GUILD, MISTY);
  gateway = discord.create(BOT_TOKEN).gateway;
  directory = createDirectoryService({ db: database.db, clock, logger: recordingLogger(), onLinkChanged: () => [] });
  directory.create({ displayName: 'Ash', playerId: '1234567', discordUserId: ASH });
  const logger = recordingLogger('message-delivery');
  records = logger.records;
  botConnected = true;
  botListeners = new Set();
  connection = { baseUrl: httpA.url, token: TOKEN };
  ready = true;
  service = createMessageDeliveryService({
    db: database.db,
    clock,
    logger,
    scheduler,
    directory,
    ready: () => ready,
    connection: () => {
      if (connection === 'unreadable') throw new Error('secrets_unreadable');
      return connection;
    },
    messages: (c) => createAttendanceMessagesHttp({ ...c, maxBytes: 256 * 1024 }),
    gateway: () => gateway,
    bot: {
      isConnected: () => botConnected,
      onStateChange: (listener) => {
        botListeners.add(listener);
        return () => botListeners.delete(listener);
      },
    },
  });
});
afterEach(async () => {
  await service.stop();
  database.close();
});

const setBot = (state: 'connected' | 'error') => {
  botConnected = state === 'connected';
  for (const listener of botListeners) listener(state);
};
const rows = () => database.db.select().from(deliveredMessage).all();
/** Starts the poller and waits for its first poll to be held by attendance. */
const started = async (http = httpA) => {
  service.start();
  await http.pollWaiting();
};
/** Hands out messages, then waits until they are handled and the next poll is held. */
const handOut = async (http: FakeAttendanceHttp, ...messages: unknown[]) => {
  const next = new Promise<void>((resolve) => setImmediate(() => void http.pollWaiting().then(resolve)));
  http.deliver(...messages);
  await next;
};

describe('the poller', () => {
  it('holds one poll with the saved token, the wait and the limit', async () => {
    await started();
    expect(httpA.polls).toEqual([{ wait: '25', limit: '20', tokenMatched: true, aborted: false }]);
    expect(httpA.waitingPolls()).toBe(1);
    expect(service.status()).toMatchObject({ state: 'polling', lastPollAt: null });
  });

  it('doesn’t poll while the bot is offline, and polls as soon as it connects', async () => {
    botConnected = false;
    service.start();
    await scheduler.nextTimer();
    expect(httpA.polls).toHaveLength(0);
    expect(service.status().state).toBe('waiting_for_bot');
    setBot('connected');
    await httpA.pollWaiting();
    expect(httpA.polls).toHaveLength(1);
  });

  it('is off without a connection or before setup is done, and says so when the token can’t be read', async () => {
    connection = null;
    service.start();
    await scheduler.nextTimer();
    expect(service.status().state).toBe('off');
    await service.stop();
    ready = false;
    connection = { baseUrl: httpA.url, token: TOKEN };
    service.start();
    await scheduler.nextTimer();
    expect(service.status().state).toBe('off');
    await service.stop();
    ready = true;
    connection = 'unreadable';
    service.start();
    await scheduler.nextTimer();
    expect(service.status().state).toBe('token_unreadable');
    expect(httpA.polls).toHaveLength(0);
  });
});

describe('delivering a message', () => {
  it('DMs the linked staff member the text, then the link, records it and reports delivered', async () => {
    await started();
    await handOut(httpA, wire(7));
    expect(discord.directMessages).toEqual([{ userId: ASH, content: `Olive Oak invited you to Cerulean League.\n\nAccept the invite: ${SECRET_URL}` }]);
    expect(discord.messages.size).toBe(0);
    expect(httpA.results).toEqual([{ id: 7, body: { status: 'delivered' } }]);
    expect(rows()).toEqual([{ connectionKey: connectionKey(httpA.url), messageId: 7, outcome: 'delivered', createdAt: NOW, reportedAt: NOW }]);
    expect(service.status()).toMatchObject({ state: 'polling', lastPollAt: NOW, lastResultAt: NOW });
  });

  it('sends nothing to a claimed or unknown player ID and reports no_discord_user', async () => {
    directory.claim({ userId: MISTY, playerId: '7654321', displayName: 'Misty' });
    await started();
    await handOut(httpA, wire(1, { playerId: '7654321' }), wire(2, { playerId: '5555555' }));
    expect(discord.directMessages).toEqual([]);
    expect(httpA.results.map((r) => r.body)).toEqual([{ status: 'no_discord_user' }, { status: 'no_discord_user' }]);
    expect(rows().map((r) => r.outcome)).toEqual(['no_discord_user', 'no_discord_user']);
  });

  it('reports a refused DM as dm_refused', async () => {
    discord.dmBehaviour.set(ASH, 'refused');
    await started();
    await handOut(httpA, wire(3));
    expect(httpA.results).toEqual([{ id: 3, body: { status: 'dm_refused' } }]);
    expect(rows().map((r) => r.outcome)).toEqual(['dm_refused']);
  });

  it('reports a Discord outage as failed without recording it, and delivers when the message comes back', async () => {
    await started();
    discord.unavailable = true;
    await handOut(httpA, wire(4));
    expect(httpA.results).toEqual([{ id: 4, body: { status: 'failed', reason: 'discord_unavailable' } }]);
    expect(rows()).toEqual([]);
    discord.unavailable = false;
    await handOut(httpA, wire(4));
    expect(httpA.results.at(-1)).toEqual({ id: 4, body: { status: 'delivered' } });
    expect(discord.directMessages).toHaveLength(1);
  });

  it('doesn’t send a message twice when attendance hands it out again, and reports the recorded outcome', async () => {
    await started();
    httpA.nextResult({ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 });
    httpA.deliver(wire(7));
    // The report fails four times (after 1, 2 and 4 s): Genie moves on and the message stays pending in attendance.
    for (const ms of [1000, 2000, 4000]) {
      expect(await scheduler.nextTimer()).toBe(ms);
      scheduler.fireNext();
    }
    await httpA.pollWaiting();
    expect(httpA.results).toEqual([]);
    expect(rows()[0]).toMatchObject({ messageId: 7, outcome: 'delivered', reportedAt: null });
    await handOut(httpA, wire(7));
    expect(discord.directMessages).toHaveLength(1);
    expect(httpA.results).toEqual([{ id: 7, body: { status: 'delivered' } }]);
    expect(rows()[0]!.reportedAt).not.toBeNull();
  });

  it('retries a failed report after 1, 2 and 4 s, then marks it reported', async () => {
    await started();
    httpA.nextResult({ status: 500 }, { status: 500 }, { status: 500 });
    httpA.deliver(wire(8));
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      waits.push(await scheduler.nextTimer());
      scheduler.fireNext();
    }
    await httpA.resultsReached(1);
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(httpA.results).toEqual([{ id: 8, body: { status: 'delivered' } }]);
  });

  it('marks a report attendance no longer wants as done, and retries a 5xx that carries a code', async () => {
    await started();
    httpA.nextResult({ status: 404, code: 'message_not_found' });
    await handOut(httpA, wire(5));
    expect(rows()[0]!.reportedAt).toBe(NOW);
    expect(records.some((r) => r.msg === 'Attendance no longer has the message.' && r.fields?.messageId === 5)).toBe(true);

    httpA.nextResult({ status: 503, code: 'shutting_down' });
    httpA.deliver(wire(6));
    expect(await scheduler.nextTimer()).toBe(1000);
    scheduler.fireNext();
    await httpA.resultsReached(1);
    expect(httpA.results).toEqual([{ id: 6, body: { status: 'delivered' } }]);
  });

  it('backs off 5 s when something throws unexpectedly, logging only the error’s name', async () => {
    directory.byPlayerIds = () => {
      throw new TypeError(`secret ${SECRET_URL}`);
    };
    await started();
    httpA.deliver(wire(1));
    expect(await scheduler.nextTimer()).toBe(5000);
    expect(service.status().state).toBe('attendance_unreachable');
    expect(records.some((r) => r.fields?.error === 'TypeError')).toBe(true);
    expect(JSON.stringify(records)).not.toContain(SECRET_URL);
  });

  it('moves on at once from a rate-limited report', async () => {
    await started();
    httpA.nextResult({ status: 429, retryAfter: '600' });
    await handOut(httpA, wire(9));
    expect(httpA.results).toEqual([]);
    expect(scheduler.pending()).toEqual([]);
    expect(rows()[0]).toMatchObject({ messageId: 9, reportedAt: null });
  });

  it('fails expired, malformed and unsafe messages without sending, and still delivers the rest in order', async () => {
    await started();
    await handOut(
      httpA,
      wire(1),
      wire(2, { text: '' }),
      wire(3, { expiresAt: new Date(NOW).toISOString() }),
      wire(4, { link: { label: 'x', url: 'javascript:alert(1)' } }),
      wire(5, { text: 'T'.repeat(1800), link: { label: 'L'.repeat(60), url: `https://a.example/${'u'.repeat(200)}` } }),
      wire(6),
    );
    expect(httpA.results).toEqual([
      { id: 1, body: { status: 'delivered' } },
      { id: 2, body: { status: 'failed', reason: 'bad_message' } },
      { id: 3, body: { status: 'failed', reason: 'expired' } },
      { id: 4, body: { status: 'failed', reason: 'invalid_link' } },
      { id: 5, body: { status: 'failed', reason: 'too_long' } },
      { id: 6, body: { status: 'delivered' } },
    ]);
    expect(discord.directMessages).toHaveLength(2);
  });

  it('sends two messages for the same player ID as two DMs', async () => {
    await started();
    await handOut(httpA, wire(1), wire(2));
    expect(discord.directMessages).toHaveLength(2);
  });

  it('starts no send 60 s after the poll answered, leaving the rest for attendance to hand out again', async () => {
    const send = gateway.sendDirectMessage.bind(gateway);
    gateway = { ...gateway, sendDirectMessage: async (userId, content) => (clock.advance(10_000), send(userId, content)) };
    await started();
    await handOut(httpA, ...Array.from({ length: 20 }, (_, i) => wire(i + 1)));
    expect(discord.directMessages).toHaveLength(6);
    expect(httpA.results.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('stops after the send in progress when the bot disconnects mid-batch, and waits for it', async () => {
    const send = gateway.sendDirectMessage.bind(gateway);
    gateway = {
      ...gateway,
      sendDirectMessage: async (userId, content) => {
        const sent = await send(userId, content);
        if (discord.directMessages.length === 1) setBot('error');
        return sent;
      },
    };
    await started();
    httpA.deliver(wire(1), wire(2), wire(3));
    await scheduler.nextTimer();
    expect(discord.directMessages).toHaveLength(1);
    expect(httpA.results.map((r) => r.id)).toEqual([1]);
    expect(service.status().state).toBe('waiting_for_bot');
    expect(httpA.waitingPolls()).toBe(0);
  });
});

describe('when the poll fails', () => {
  it('waits as the failure table says before polling again', async () => {
    httpA.nextPoll({ kind: 'status', status: 403, code: 'insufficient_scope' });
    service.start();
    expect(await scheduler.nextTimer()).toBe(300_000);
    expect(service.status().state).toBe('missing_scope');
    expect(httpA.polls).toHaveLength(1);
    scheduler.fireNext();
    await httpA.pollWaiting();
    expect(httpA.polls).toHaveLength(2);
    // The state stays until attendance answers the new poll.
    expect(service.status().state).toBe('missing_scope');
    clock.advance(25_000);
    await handOut(httpA, wire(1));
    expect(service.status().state).toBe('polling');
  });

  it('backs off a refused token, an old attendance and a rate limit, and doubles an outage', async () => {
    httpA.nextPoll(
      { kind: 'status', status: 404 },
      { kind: 'status', status: 429, retryAfter: '90' },
      { kind: 'status', status: 502 },
      { kind: 'status', status: 502 },
      { kind: 'status', status: 400 },
    );
    service.start();
    const seen: [string, number][] = [];
    for (let i = 0; i < 5; i++) {
      const ms = await scheduler.nextTimer();
      seen.push([service.status().state, ms]);
      scheduler.fireNext();
    }
    expect(seen).toEqual([
      ['unsupported', 300_000],
      ['rate_limited', 90_000],
      ['attendance_unreachable', 5000],
      ['attendance_unreachable', 10_000],
      ['rejected', 300_000],
    ]);
  });

  it('starts no more than 110 polls in 15 minutes when attendance answers every poll at once', async () => {
    httpA.nextPoll(...Array.from({ length: 111 }, () => ({ kind: 'body' as const, body: { messages: [] } })));
    service.start();
    for (let i = 0; i < 110; i++) {
      expect(await scheduler.nextTimer()).toBe(5000);
      scheduler.fireNext();
    }
    // 110 polls 5 s apart took 550 s; the 111th waits until the first leaves the 15-minute window.
    expect(await scheduler.nextTimer()).toBe(900_000 - 550_000);
    expect(httpA.polls).toHaveLength(110);
    scheduler.fireNext();
    await expect.poll(() => httpA.polls.length).toBe(111);
  });

  it('pauses after an empty answer that came back at once', async () => {
    await started();
    httpA.answerPolls();
    expect(await scheduler.nextTimer()).toBe(5000);
    scheduler.fireNext();
    await httpA.pollWaiting();
    expect(httpA.polls).toHaveLength(2);
  });
});

describe('a connection change', () => {
  it('sends nothing more of a batch to either attendance once the connection is saved again', async () => {
    const send = gateway.sendDirectMessage.bind(gateway);
    gateway = {
      ...gateway,
      sendDirectMessage: async (userId, content) => {
        const sent = await send(userId, content);
        if (discord.directMessages.length === 2) {
          const before = connection as { baseUrl: string };
          connection = { baseUrl: httpB.url, token: TOKEN };
          service.connectionChanged({ before: { baseUrl: before.baseUrl }, after: { baseUrl: httpB.url } });
        }
        return sent;
      },
    };
    await started();
    httpA.deliver(wire(1), wire(2), wire(3));
    await httpB.pollWaiting();
    expect(httpA.results.map((r) => r.id)).toEqual([1]);
    expect(httpB.results).toEqual([]);
    expect(rows().map((r) => r.messageId)).toEqual([1]);
    expect(discord.directMessages).toHaveLength(2);
  });

  it('keys records by attendance, so another attendance’s message 7 is sent, and removal forgets the old key', async () => {
    await started();
    await handOut(httpA, wire(7));
    connection = { baseUrl: httpB.url, token: TOKEN };
    service.connectionChanged({ before: { baseUrl: httpA.url }, after: { baseUrl: httpB.url } });
    await httpB.pollWaiting();
    await handOut(httpB, wire(7));
    expect(discord.directMessages).toHaveLength(2);
    expect(httpB.results).toEqual([{ id: 7, body: { status: 'delivered' } }]);

    connection = null;
    service.connectionChanged({ before: { baseUrl: httpB.url }, after: null });
    await scheduler.nextTimer();
    expect(rows().map((r) => r.connectionKey)).toEqual([connectionKey(httpA.url)]);
    expect(service.status().state).toBe('off');
  });

  it('drops an old problem as soon as the organizer saves the connection again', async () => {
    httpA.nextPoll({ kind: 'status', status: 403, code: 'insufficient_scope' });
    service.start();
    await scheduler.nextTimer();
    expect(service.status().state).toBe('missing_scope');
    service.connectionChanged({ before: { baseUrl: httpA.url }, after: { baseUrl: httpA.url } });
    expect(service.status().state).toBe('polling');
    await httpA.pollWaiting();
    expect(service.status().state).toBe('polling');
  });

  it('keeps the records when only the token changes', async () => {
    await started();
    await handOut(httpA, wire(7));
    service.connectionChanged({ before: { baseUrl: httpA.url }, after: { baseUrl: httpA.url } });
    // The held second poll is aborted and a third starts; wait for attendance to let the second go.
    await expect.poll(() => httpA.polls.length).toBe(3);
    await expect.poll(() => httpA.waitingPolls()).toBe(1);
    expect(httpA.polls[1]!.aborted).toBe(true);
    await handOut(httpA, wire(7));
    expect(discord.directMessages).toHaveLength(1);
    expect(httpA.results.map((r) => r.body)).toEqual([{ status: 'delivered' }, { status: 'delivered' }]);
  });
});

describe('stopping and sweeping', () => {
  it('aborts the held poll on stop and polls no more', async () => {
    await started();
    await service.stop();
    await expect.poll(() => httpA.polls[0]?.aborted).toBe(true);
    expect(httpA.polls).toHaveLength(1);
    expect(scheduler.pending()).toEqual([]);
  });

  it('writes no record and posts no result for a send that finishes after stop', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const send = gateway.sendDirectMessage.bind(gateway);
    let entered!: () => void;
    const sending = new Promise<void>((resolve) => (entered = resolve));
    gateway = { ...gateway, sendDirectMessage: async (userId, content) => (entered(), await held, send(userId, content)) };
    await started();
    httpA.deliver(wire(1));
    await sending;
    // stop() resolves while Discord still holds the send: shutdown never waits on Discord.
    await service.stop();
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(discord.directMessages).toHaveLength(1);
    expect(rows()).toEqual([]);
    expect(httpA.results).toEqual([]);
    expect(httpA.polls).toHaveLength(1);
  });

  it('runs one loop when started again while a stopped one still waits on Discord', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const send = gateway.sendDirectMessage.bind(gateway);
    let first = true;
    gateway = {
      ...gateway,
      sendDirectMessage: async (userId, content) => {
        if (first) {
          first = false;
          await held;
        }
        return send(userId, content);
      },
    };
    await started();
    httpA.deliver(wire(1));
    await expect.poll(() => first).toBe(false);
    await service.stop();
    service.start();
    await httpA.pollWaiting();
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(httpA.polls).toHaveLength(2);
    expect(httpA.waitingPolls()).toBe(1);
    expect(rows()).toEqual([]);
  });

  it('deletes records older than 30 days at start, and again once a day has passed', async () => {
    const key = connectionKey(httpA.url);
    database.db
      .insert(deliveredMessage)
      .values([
        { connectionKey: key, messageId: 1, outcome: 'delivered', createdAt: NOW - 31 * 86_400_000, reportedAt: null },
        { connectionKey: key, messageId: 2, outcome: 'delivered', createdAt: NOW - 29 * 86_400_000, reportedAt: null },
      ])
      .run();
    await started();
    expect(rows().map((r) => r.messageId)).toEqual([2]);

    clock.advance(12 * 3_600_000);
    await handOut(httpA);
    expect(rows().map((r) => r.messageId)).toEqual([2]);
    clock.advance(12 * 3_600_000);
    await handOut(httpA);
    expect(rows()).toEqual([]);
  });
});

describe('what the poller logs', () => {
  it('never logs a message’s text, link or player ID, nor the token', async () => {
    discord.dmBehaviour.set(ASH, 'refused');
    await started();
    await handOut(httpA, wire(1), wire(2, { playerId: '7777777' }));
    const logged = JSON.stringify(records);
    for (const secret of [SECRET_URL, 'Olive Oak invited you', '1234567', '7777777', TOKEN, ASH]) expect(logged).not.toContain(secret);
    expect(records.some((r) => r.fields?.messageId === 1 && r.fields?.status === 'dm_refused')).toBe(true);
  });
});
