import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Readiness: the database file is still there (an open handle keeps answering after the volume goes away) and
 * answers a query.
 */
export default defineEventHandler((event) => {
  try {
    const path = resolve(useRuntimeConfig().databasePath);
    if (!existsSync(path)) throw new Error('The database file is gone.');
    useDatabase().sqlite.prepare('select count(*) from install').get();
    return { status: 'ready' };
  } catch {
    setResponseStatus(event, 503);
    return { status: 'unavailable' };
  }
});
