/**
 * The exports folder (§5.2: `<exportsDir>/<day>/<run>/…`). Paths are built from Genie's integer IDs and Discord
 * snowflakes only, never from a name someone typed, and every stored path is checked to stay inside the folder.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { SNOWFLAKE } from '../../../shared/closeout';

export type ExportsFolder = ReturnType<typeof exportsFolder>;

export function exportsFolder(root: string) {
  const base = resolve(root);

  /** The absolute path of a stored relative path, or `null` when it would leave the folder. */
  function inside(path: string): string | null {
    const full = resolve(base, path);
    const rel = relative(base, full);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? full : null;
  }

  const id = (value: string | number): string => {
    const text = String(value);
    if (!SNOWFLAKE.test(text)) throw new Error(`Not an ID for a path: ${text}`);
    return text;
  };

  return {
    root: base,
    inside,
    /** A run's relative path for one file: `<day>/<run>/<folder>/<id><ext>`. */
    pathFor(dayId: number, runId: number, folder: 'csv' | 'transcripts' | 'threads' | 'attachments', name: string | number, ext = ''): string {
      return join(id(dayId), id(runId), folder, `${id(name)}${ext}`);
    },
    /** Writes atomically (temporary name, flushed, renamed), folders 0700 and files 0600; answers the size and hash. */
    async write(path: string, content: string | Buffer): Promise<{ bytes: number; sha256: string }> {
      const full = inside(path);
      if (!full) throw new Error('An export path left the exports folder.');
      await mkdir(dirname(full), { recursive: true, mode: 0o700 });
      const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      const partial = `${full}.part`;
      const handle = await open(partial, 'w', 0o600);
      try {
        await handle.write(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(partial, full);
      return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    },
    /** Where a download is written to (the fetcher streams it); its folder is created first. */
    async prepare(path: string): Promise<string> {
      const full = inside(path);
      if (!full) throw new Error('An export path left the exports folder.');
      await mkdir(dirname(full), { recursive: true, mode: 0o700 });
      return full;
    },
    /** `ok`, `missing` or `mismatch` against the recorded hash, read as a stream. */
    async check(path: string, sha256: string): Promise<'ok' | 'missing' | 'mismatch'> {
      const full = inside(path);
      if (!full) return 'missing';
      const hash = createHash('sha256');
      try {
        for await (const chunk of createReadStream(full)) hash.update(chunk as Buffer);
      } catch {
        return 'missing';
      }
      return hash.digest('hex') === sha256 ? 'ok' : 'mismatch';
    },
    async remove(path: string): Promise<void> {
      const full = inside(path);
      if (full) await rm(full, { force: true });
    },
    /** A run's whole folder (a failed run's files). */
    async removeRun(dayId: number, runId: number): Promise<void> {
      await rm(join(base, id(dayId), id(runId)), { recursive: true, force: true });
    },
    /** Removes empty folders under the day's folder, then the day's folder if it is empty. */
    async prune(dayId: number): Promise<void> {
      const day = join(base, id(dayId));
      const walk = async (dir: string): Promise<boolean> => {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return false;
        }
        let empty = true;
        for (const e of entries) {
          if (e.isDirectory() && (await walk(join(dir, e.name)))) continue;
          empty = false;
        }
        if (empty) await rmdir(dir).catch(() => undefined);
        return empty;
      };
      await walk(day);
    },
  };
}
