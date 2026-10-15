import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, freshDb } from '../../test/support/db';
import { migrateDatabase, openDatabase } from './client';

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** A migrations folder holding only the first `count` migrations, to stand up an older install. */
function migrationsUpTo(count: number): string {
  dir = mkdtempSync(join(tmpdir(), 'genie-migrations-'));
  cpSync(MIGRATIONS, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, count);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe('the M2 migration', () => {
  it('keeps every M1 job and job event when it rebuilds the job table', () => {
    const database = openDatabase(':memory:');
    migrateDatabase(database.db, migrationsUpTo(1));
    database.sqlite.exec(`
      INSERT INTO job (id, kind, state, payload, attempts, created_at) VALUES (1, 'retention_sweep', 'succeeded', NULL, 1, 10);
      INSERT INTO job_event (job_id, at, level, message) VALUES (1, 11, 'info', 'claimed'), (1, 12, 'info', 'succeeded');
    `);

    migrateDatabase(database.db, MIGRATIONS);

    expect(database.sqlite.prepare('SELECT id, kind, state FROM job').all()).toEqual([{ id: 1, kind: 'retention_sweep', state: 'succeeded' }]);
    expect(database.sqlite.prepare('SELECT job_id, message FROM job_event ORDER BY id').all()).toEqual([
      { job_id: 1, message: 'claimed' },
      { job_id: 1, message: 'succeeded' },
    ]);
    expect(database.sqlite.pragma('foreign_key_check')).toEqual([]);
    database.close();
  });

  it('refers job.day_id to event_day', () => {
    const database = freshDb();
    expect(() => database.sqlite.exec(`INSERT INTO job (kind, state, day_id, attempts, created_at) VALUES ('sync', 'queued', 999, 0, 1)`)).toThrow(/FOREIGN KEY/);
    database.close();
  });

  it('seeds exactly one default blueprint with §6.2’s four channels', () => {
    const database = freshDb();
    expect(database.sqlite.prepare('SELECT name, category_name_pattern, is_default FROM blueprint').all()).toEqual([
      { name: 'Standard day', category_name_pattern: '🏆 {weekday} {date} · {title}', is_default: 1 },
    ]);
    expect(database.sqlite.prepare('SELECT key, scope, name_pattern, audience, purpose FROM blueprint_channel ORDER BY position').all()).toEqual([
      { key: 'day-staff', scope: 'day', name_pattern: 'day-staff', audience: 'all_staff', purpose: 'general' },
      { key: 'head-judges', scope: 'day', name_pattern: 'head-judges', audience: 'head_judges', purpose: 'general' },
      { key: 'floor', scope: 'per_event', name_pattern: '{slug}-floor', audience: 'event_staff', purpose: 'floor' },
      { key: 'penalties', scope: 'per_event', name_pattern: '{slug}-penalties', audience: 'event_staff', purpose: 'penalties' },
    ]);
    database.close();
  });

  it('allows one present channel per day, event and key (the hand-written index)', () => {
    const database = freshDb();
    database.sqlite.exec(`
      INSERT INTO event_day (id, guild_id, date, title, blueprint_id, created_at, updated_at) VALUES (1, 'g', '2026-10-17', 'T', 1, 1, 1);
      INSERT INTO provisioned_channel (day_id, guild_id, event_id, blueprint_channel_key, discord_channel_id, applied_overwrites_hash, state, created_at, updated_at)
        VALUES (1, 'g', NULL, 'day-staff', 'c1', 'h', 'present', 1, 1), (1, 'g', NULL, 'day-staff', 'c0', 'h', 'missing', 1, 1);
    `);
    const second = `INSERT INTO provisioned_channel (day_id, guild_id, event_id, blueprint_channel_key, discord_channel_id, applied_overwrites_hash, state, created_at, updated_at)
      VALUES (1, 'g', NULL, 'day-staff', 'c2', 'h', 'present', 1, 1)`;
    expect(() => database.sqlite.exec(second)).toThrow(/UNIQUE/);
    database.close();
  });

  it('enforces the directory’s link states', () => {
    const database = freshDb();
    const insert = (state: string, discord: string | null, claim: string | null) =>
      database.sqlite
        .prepare('INSERT INTO staff_member (display_name, discord_user_id, claimed_discord_user_id, link_state, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)')
        .run('x', discord, claim, state);
    expect(() => insert('linked', 'u1', null)).not.toThrow();
    expect(() => insert('claimed', null, 'u2')).not.toThrow();
    expect(() => insert('unlinked', null, null)).not.toThrow();
    expect(() => insert('linked', null, null)).toThrow(/CHECK/);
    expect(() => insert('claimed', 'u3', 'u4')).toThrow(/CHECK/);
    expect(() => insert('unlinked', 'u5', null)).toThrow(/CHECK/);
    database.close();
  });
});

describe('the M3 migration', () => {
  it('keeps the sealed bot token and client secret when it rebuilds sealed_secret, and accepts the attendance token', () => {
    const database = openDatabase(':memory:');
    migrateDatabase(database.db, migrationsUpTo(2));
    database.sqlite.exec(`
      INSERT INTO sealed_secret (name, ciphertext, updated_at) VALUES ('discord_bot_token', x'0102', 5), ('discord_client_secret', x'0304', 6);
    `);

    migrateDatabase(database.db, MIGRATIONS);

    expect(database.sqlite.prepare('SELECT name, hex(ciphertext) AS c, updated_at FROM sealed_secret ORDER BY name').all()).toEqual([
      { name: 'discord_bot_token', c: '0102', updated_at: 5 },
      { name: 'discord_client_secret', c: '0304', updated_at: 6 },
    ]);
    expect(() => database.sqlite.exec(`INSERT INTO sealed_secret (name, ciphertext, updated_at) VALUES ('attendance_token', x'05', 7)`)).not.toThrow();
    expect(() => database.sqlite.exec(`INSERT INTO sealed_secret (name, ciphertext, updated_at) VALUES ('other', x'05', 7)`)).toThrow(/CHECK/);
    database.close();
  });

  it('keeps M2 days, events and staff, marking them hand-made', () => {
    const database = openDatabase(':memory:');
    migrateDatabase(database.db, migrationsUpTo(2));
    database.sqlite.exec(`
      INSERT INTO event_day (id, guild_id, date, title, blueprint_id, created_at, updated_at) VALUES (1, 'g', '2026-10-17', 'T', 1, 1, 1);
      INSERT INTO event (id, day_id, name, slug, game, starts_at) VALUES (1, 1, 'LC', 'lc', 'tcg', 1);
      INSERT INTO staff_member (id, display_name, link_state, created_at, updated_at) VALUES (1, 'Ash', 'unlinked', 1, 1);
      INSERT INTO day_staff (day_id, staff_member_id) VALUES (1, 1);
      INSERT INTO event_staff (event_id, staff_member_id, role) VALUES (1, 1, 'judge');
    `);

    migrateDatabase(database.db, MIGRATIONS);

    expect(database.sqlite.prepare('SELECT source, attendance_refreshed_at FROM event_day').get()).toEqual({ source: 'manual', attendance_refreshed_at: null });
    expect(database.sqlite.prepare('SELECT attendance_tournament_id FROM event').get()).toEqual({ attendance_tournament_id: null });
    expect(database.sqlite.prepare('SELECT imported FROM day_staff').get()).toEqual({ imported: 0 });
    expect(database.sqlite.prepare('SELECT imported FROM event_staff').get()).toEqual({ imported: 0 });
    expect(database.sqlite.pragma('foreign_key_check')).toEqual([]);
    database.close();
  });

  it('links a tournament to at most one event per day, and drops a day’s snapshot with the day', () => {
    const database = freshDb();
    database.sqlite.exec(`
      INSERT INTO event_day (id, guild_id, date, title, blueprint_id, created_at, updated_at) VALUES (1, 'g', '2026-10-17', 'T', 1, 1, 1), (2, 'g', '2026-10-18', 'U', 1, 1, 1);
      INSERT INTO event (day_id, name, slug, game, starts_at, attendance_tournament_id) VALUES (1, 'A', 'a', 'tcg', 1, 't1'), (1, 'B', 'b', 'tcg', 1, NULL), (1, 'C', 'c', 'tcg', 1, NULL), (2, 'A', 'a', 'tcg', 1, 't1');
      INSERT INTO attendance_snapshot (day_id, snapshot_id, payload, plan_revision, day_state, fetched_at, fetched_by) VALUES (1, 's1', '{}', 1, 'draft', 1, 'u');
    `);
    expect(() => database.sqlite.exec(`INSERT INTO event (day_id, name, slug, game, starts_at, attendance_tournament_id) VALUES (1, 'D', 'd', 'tcg', 1, 't1')`)).toThrow(/UNIQUE/);
    expect(() => database.sqlite.exec(`INSERT INTO event_day (guild_id, date, title, blueprint_id, source, created_at, updated_at) VALUES ('g', 'x', 'x', 1, 'other', 1, 1)`)).toThrow(/CHECK/);
    expect(() => database.sqlite.exec(`INSERT INTO attendance_connection (id, base_url, token_hint, updated_at) VALUES (2, 'http://a', 'h', 1)`)).toThrow(/CHECK/);

    database.sqlite.exec('DELETE FROM event_day WHERE id = 1');
    expect(database.sqlite.prepare('SELECT count(*) AS n FROM attendance_snapshot').get()).toEqual({ n: 0 });
    database.close();
  });
});
