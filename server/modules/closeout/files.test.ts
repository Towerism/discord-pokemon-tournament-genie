import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportsFolder } from './files';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genie-folder-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the exports folder', () => {
  it('keeps every path inside it', () => {
    const folder = exportsFolder(dir);
    expect(folder.inside('1/2/csv/3.csv')).toBe(join(dir, '1/2/csv/3.csv'));
    for (const escape of ['', '.', '../app.db', '../../etc/passwd', '/etc/passwd', '1/../../x']) expect(folder.inside(escape), escape).toBeNull();
  });

  it('builds paths from IDs only', () => {
    const folder = exportsFolder(dir);
    expect(folder.pathFor(1, 2, 'attachments', '900000000000000001')).toBe(join('1', '2', 'attachments', '900000000000000001'));
    for (const bad of ['../x', 'a', '1/2', '']) expect(() => folder.pathFor(1, 2, 'attachments', bad), bad).toThrow(/Not an ID/);
  });

  it('writes atomically with owner-only modes, and checks hashes', async () => {
    const folder = exportsFolder(dir);
    const written = await folder.write('1/2/csv/3.csv', Buffer.from('a,b\n'));
    expect(written).toEqual({ bytes: 4, sha256: createHash('sha256').update('a,b\n').digest('hex') });
    expect(readFileSync(join(dir, '1/2/csv/3.csv'), 'utf8')).toBe('a,b\n');
    expect(statSync(join(dir, '1/2/csv/3.csv')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, '1/2')).mode & 0o777).toBe(0o700);
    expect(existsSync(join(dir, '1/2/csv/3.csv.part'))).toBe(false);
    expect(await folder.check('1/2/csv/3.csv', written.sha256)).toBe('ok');
    writeFileSync(join(dir, '1/2/csv/3.csv'), 'a,c\n');
    expect(await folder.check('1/2/csv/3.csv', written.sha256)).toBe('mismatch');
    expect(await folder.check('1/2/csv/missing.csv', written.sha256)).toBe('missing');
    expect(await folder.check('../escape', written.sha256)).toBe('missing');
  });

  it('refuses to write, prepare or remove outside it', async () => {
    writeFileSync(join(dir, 'keep'), 'x');
    const folder = exportsFolder(join(dir, 'exports'));
    await expect(folder.write('../keep', 'y')).rejects.toThrow(/left the exports folder/);
    await expect(folder.prepare('../keep')).rejects.toThrow(/left the exports folder/);
    await folder.remove('../keep');
    expect(readFileSync(join(dir, 'keep'), 'utf8')).toBe('x');
  });

  it('removes a run, then prunes empty folders and the day', async () => {
    const folder = exportsFolder(dir);
    await folder.write('1/2/csv/3.csv', 'x');
    await folder.write('1/4/csv/3.csv', 'x');
    await folder.removeRun(1, 2);
    expect(existsSync(join(dir, '1/2'))).toBe(false);
    await folder.prune(1);
    expect(existsSync(join(dir, '1/4/csv/3.csv'))).toBe(true);
    await folder.remove('1/4/csv/3.csv');
    await folder.prune(1);
    expect(existsSync(join(dir, '1'))).toBe(false);
    await folder.prune(9);
  });
});
