/**
 * Names for downloaded files. Files on disk are named from IDs only (NFR-4); the name a browser offers comes from
 * what staff uploaded, so it is cleaned of anything a filesystem or a header could misread.
 */

const MAX_NAME = 100;

/** Discord IDs as they may appear in a path. */
export const SNOWFLAKE = /^\d{1,20}$/;

/** Path separators, quotes, control characters and bidi overrides removed; length capped with the extension kept. */
export function safeDownloadName(name: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  let clean = name.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
  clean = clean.split(/[\\/]/).at(-1)!.replace(/["*:<>?|]/g, '').trim();
  clean = clean.replace(/^\.+/, '');
  if (!clean.replace(/\./g, '').trim()) return fallback;
  if (clean.length <= MAX_NAME) return clean;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : '';
  return clean.slice(0, MAX_NAME - ext.length) + ext;
}

/** RFC 6266: an ASCII fallback name, and the exact name in UTF-8. */
export function contentDisposition(name: string, type: 'attachment' | 'inline' = 'attachment'): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
