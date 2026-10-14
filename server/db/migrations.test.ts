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
