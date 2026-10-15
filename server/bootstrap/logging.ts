import { type LogDestination, type Logger, createLogger, createRedactor, secretKeyNames } from '@towerism/selfhost-kit';
import { SECRETS } from './secrets';

/**
 * Redaction (architecture §10): the kit's base credential keys plus message content, penalty notes, competitors'
 * player IDs, void reasons, attachment file names and thread names, any request body a library attaches to its errors, Genie's tokens and the env names of
 * its secrets. It lives here, free of Nitro auto-imports, because the launcher is bundled without Nitro.
 */
export const redactor = createRedactor({
  extraKeys: ['content', 'notes', 'competitorPlayerId', 'voidReason', 'requestBody', 'filename', 'threadName', 'botToken', 'attendanceToken', 'clientSecret', ...secretKeyNames(SECRETS)],
});

/** The launcher's logger: the kit requires the app's own, so that startup logs hide Genie's keys too. */
export function startupLogger(destination?: LogDestination): Logger {
  return createLogger({ scope: 'startup', redactor, destination });
}
