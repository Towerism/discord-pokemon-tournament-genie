import { silentLogger } from '@towerism/selfhost-kit';
import { type FakeClock, fakeClock } from '@towerism/selfhost-kit/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from '../../../test/support/db';
import { testVault } from '../../../test/support/discord-world';
import type { OpenDatabase } from '../../db/client';
import { type AttendanceConnectionService, createAttendanceConnectionService } from './attendance-connection';
import { SetupError } from './errors';
import { createSetupStore } from './store';

const TOKEN = `ppa_int_${'Q'.repeat(39)}z9_-`;
const OTHER = `ppa_int_${'R'.repeat(39)}AbCd`;

let database: OpenDatabase;
let clock: FakeClock;
let vault: ReturnType<typeof testVault>;
let connection: AttendanceConnectionService;

beforeEach(() => {
  database = freshDb();
  clock = fakeClock(1_000);
  vault = testVault();
  connection = createAttendanceConnectionService({ store: createSetupStore(database.db), vault, clock, logger: silentLogger });
});
afterEach(() => database.close());

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof SetupError) return `${err.status} ${err.code}`;
    throw err;
  }
  return 'no refusal';
};
const sealedRow = () => database.sqlite.prepare("SELECT ciphertext FROM sealed_secret WHERE name = 'attendance_token'").get() as { ciphertext: Buffer } | undefined;

describe('the attendance connection', () => {
  it('starts unconfigured', () => {
    expect(connection.view()).toEqual({ configured: false });
    expect(connection.connection()).toBeNull();
  });

  it('stores the base URL without a trailing slash and the token only sealed, answering a hint', () => {
    clock.set(5_000);
    expect(connection.put({ baseUrl: 'http://Unraid.local:3000/', token: TOKEN })).toEqual({
      configured: true,
      baseUrl: 'http://unraid.local:3000',
      tokenHint: 'ppa_int_…z9_-',
      updatedAt: 5_000,
    });
    expect(connection.connection()).toEqual({ baseUrl: 'http://unraid.local:3000', token: TOKEN });
    expect(sealedRow()!.ciphertext.includes(Buffer.from(TOKEN))).toBe(false);
    expect(() => vault.decrypt(sealedRow()!.ciphertext, 'sealed_secret:discord_bot_token')).toThrow();
  });

  it('keeps the stored token only for the same base URL', () => {
    connection.put({ baseUrl: 'http://attendance:3000', token: TOKEN });

    expect(connection.put({ baseUrl: 'http://ATTENDANCE:3000/' })).toMatchObject({ baseUrl: 'http://attendance:3000', tokenHint: 'ppa_int_…z9_-' });
    expect(connection.connection()!.token).toBe(TOKEN);

    expect(refusal(() => connection.put({ baseUrl: 'http://elsewhere:3000' }))).toBe('422 token_required');
    expect(connection.view()).toMatchObject({ baseUrl: 'http://attendance:3000' });

    connection.put({ baseUrl: 'http://elsewhere:3000', token: OTHER });
    expect(connection.connection()).toEqual({ baseUrl: 'http://elsewhere:3000', token: OTHER });
  });

  it('needs a token the first time', () => {
    expect(refusal(() => connection.put({ baseUrl: 'http://attendance:3000' }))).toBe('422 token_required');
    expect(connection.view()).toEqual({ configured: false });
  });

  it('forgets the URL and the token on remove', () => {
    connection.put({ baseUrl: 'http://attendance:3000', token: TOKEN });
    connection.remove();
    expect(connection.view()).toEqual({ configured: false });
    expect(sealedRow()).toBeUndefined();
    connection.remove();
  });

  it('refuses a token sealed under another key', () => {
    connection.put({ baseUrl: 'http://attendance:3000', token: TOKEN });
    const other = createAttendanceConnectionService({ store: createSetupStore(database.db), vault: testVault(), clock, logger: silentLogger });
    expect(refusal(() => other.connection())).toBe('503 secrets_unreadable');
  });

  it('tells the hook about every save and removal, after it is stored', () => {
    const changes: unknown[] = [];
    const watched = createAttendanceConnectionService({
      store: createSetupStore(database.db),
      vault,
      clock,
      logger: silentLogger,
      onConnectionChanged: (change) => changes.push({ ...change, stored: watched.view().configured }),
    });
    watched.put({ baseUrl: 'http://attendance:3000/', token: TOKEN });
    watched.put({ baseUrl: 'http://attendance:3000', token: OTHER });
    watched.put({ baseUrl: 'http://other:3000', token: TOKEN });
    expect(refusal(() => watched.put({ baseUrl: 'http://third:3000' }))).toBe('422 token_required');
    watched.remove();
    watched.remove();
    expect(changes).toEqual([
      { before: null, after: { baseUrl: 'http://attendance:3000' }, stored: true },
      { before: { baseUrl: 'http://attendance:3000' }, after: { baseUrl: 'http://attendance:3000' }, stored: true },
      { before: { baseUrl: 'http://attendance:3000' }, after: { baseUrl: 'http://other:3000' }, stored: true },
      { before: { baseUrl: 'http://other:3000' }, after: null, stored: false },
    ]);
  });
});
