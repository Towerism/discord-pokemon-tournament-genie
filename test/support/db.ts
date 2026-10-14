import { resolve } from 'node:path';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../server/db/client';

export const MIGRATIONS = resolve(import.meta.dirname, '../../server/db/migrations');

/** A fresh, migrated in-memory database. One per test; nothing is shared. */
export function freshDb(): OpenDatabase {
  const database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS);
  return database;
}
