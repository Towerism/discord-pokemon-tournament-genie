import { resolve } from 'node:path';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../db/client';

let database: OpenDatabase | undefined;

/** Opens and migrates the database on first use; the database plugin does that at boot. */
export function useDatabase(): OpenDatabase {
  if (!database) {
    const config = useRuntimeConfig();
    database = openDatabase(resolve(config.databasePath));
    migrateDatabase(database.db, resolve(config.migrationsDir));
  }
  return database;
}

export function closeDatabase(): void {
  database?.close();
  database = undefined;
}
