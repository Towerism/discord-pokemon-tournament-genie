import type { Clock, Logger, StringVault } from '@towerism/selfhost-kit';
import { SetupError } from './errors';
import { aadFor } from './service';
import type { SetupStore } from './store';

export type AttendanceConnectionView = { configured: false } | { configured: true; baseUrl: string; tokenHint: string; updatedAt: number };

/** Removes one trailing `/` after the URL's own normalization (lowercase host, default path). */
export function normalizeBaseUrl(raw: string): string {
  return new URL(raw).href.replace(/\/$/, '');
}

/**
 * Where attendance answers and the token Genie reads it with (ADR-0008, §9). The token is sealed in the vault and
 * never leaves this module in clear except to the attendance adapter. A new base URL needs the token typed again, so
 * the sealed token can't be pointed at another host.
 */
export function createAttendanceConnectionService(opts: { store: SetupStore; vault: StringVault; clock: Clock; logger: Logger }) {
  const { store, vault, clock, logger } = opts;
  const AAD = aadFor('attendance_token');

  function view(): AttendanceConnectionView {
    const row = store.attendanceConnection();
    return row ? { configured: true, baseUrl: row.baseUrl, tokenHint: row.tokenHint, updatedAt: row.updatedAt } : { configured: false };
  }

  return {
    view,

    put(input: { baseUrl: string; token?: string }): AttendanceConnectionView {
      const baseUrl = normalizeBaseUrl(input.baseUrl);
      const stored = store.attendanceConnection();
      if (input.token === undefined && (!stored || stored.baseUrl !== baseUrl)) {
        throw new SetupError(422, 'token_required', 'Paste the token again: it is needed for a new attendance address.');
      }
      const now = clock.now();
      if (input.token === undefined) {
        store.putAttendanceConnection({ baseUrl, tokenHint: stored!.tokenHint, ciphertext: null }, now);
      } else {
        store.putAttendanceConnection({ baseUrl, tokenHint: `ppa_int_…${input.token.slice(-4)}`, ciphertext: vault.encrypt(input.token, AAD) }, now);
      }
      const saved = view();
      logger.info('Attendance connection saved.', saved.configured ? { baseUrl: saved.baseUrl, tokenHint: saved.tokenHint } : {});
      return saved;
    },

    remove(): void {
      store.removeAttendanceConnection();
      logger.info('Attendance connection removed.');
    },

    /** The URL and the token in clear, for the adapter only; `null` when none is configured. */
    connection(): { baseUrl: string; token: string } | null {
      const row = store.attendanceConnection();
      const blob = store.sealed('attendance_token');
      if (!row || !blob) return null;
      try {
        return { baseUrl: row.baseUrl, token: vault.decrypt(blob, AAD) };
      } catch {
        throw new SetupError(503, 'secrets_unreadable', 'The stored attendance token could not be unsealed; check NUXT_VAULT_KEY.');
      }
    },
  };
}

export type AttendanceConnectionService = ReturnType<typeof createAttendanceConnectionService>;
