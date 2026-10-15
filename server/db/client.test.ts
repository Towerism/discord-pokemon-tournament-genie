import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../test/support/db';
import { migrateDatabase, openDatabase } from './client';

const dirs: string[] = [];
const tempPath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'genie-db-'));
  dirs.push(dir);
  return join(dir, 'nested', 'app.db');
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('creates the file with the pragmas ADR-0002 relies on and the M1 to M5 tables', () => {
    const database = openDatabase(tempPath());
    migrateDatabase(database.db, MIGRATIONS);
    const { sqlite } = database;
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(sqlite.pragma('synchronous', { simple: true })).toBe(1);
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
    const tables = sqlite
      .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '__drizzle%' order by name")
      .pluck()
      .all();
    expect(tables).toEqual([
      'app_setting',
      'attendance_connection',
      'attendance_snapshot',
      'blueprint',
      'blueprint_channel',
      'day_closeout',
      'day_staff',
      'day_template',
      'day_template_event',
      'event',
      'event_day',
      'event_staff',
      'export_attachment',
      'export_file',
      'export_run',
      'guild_binding',
      'install',
      'job',
      'job_event',
      'login_audit',
      'organizer_allowlist',
      'orphan_channel',
      'penalty',
      'penalty_category',
      'penalty_revision',
      'penalty_type',
      'provisioned_channel',
      'sealed_secret',
      'staff_member',
    ]);
    database.close();
  });

  it('runs no migration twice, and checkpoints the WAL on close', () => {
    const path = tempPath();
    const first = openDatabase(path);
    migrateDatabase(first.db, MIGRATIONS);
    first.sqlite.prepare('insert into install (id, created_at) values (1, 0)').run();
    first.close();

    const second = openDatabase(path);
    migrateDatabase(second.db, MIGRATIONS);
    expect(second.sqlite.prepare('select count(*) from install').pluck().get()).toBe(1);
    second.close();
    const wal = `${path}-wal`;
    expect(!existsSync(wal) || statSync(wal).size === 0).toBe(true);
  });

  it('enforces the single install row and the enum checks', () => {
    const database = openDatabase(':memory:');
    migrateDatabase(database.db, MIGRATIONS);
    expect(() => database.sqlite.prepare('insert into install (id, created_at) values (2, 0)').run()).toThrow(/CHECK/);
    expect(() =>
      database.sqlite.prepare("insert into job (kind, state, created_at) values ('nope', 'queued', 0)").run(),
    ).toThrow(/CHECK/);
    database.close();
  });
});
