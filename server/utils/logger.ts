import { type Logger, createLogger, createRedactor, secretKeyNames } from '@towerism/selfhost-kit';
import { SECRETS } from '../bootstrap/secrets';

/**
 * Redaction (architecture §10): the kit's base credential keys plus message content, penalty notes, competitors'
 * player IDs, void reasons, attachment file names and thread names, any request body a library attaches to its errors, Genie's tokens and the env names of
 * its secrets.
 */
export const redactor = createRedactor({
  extraKeys: ['content', 'notes', 'competitorPlayerId', 'voidReason', 'requestBody', 'filename', 'threadName', 'botToken', 'attendanceToken', 'clientSecret', ...secretKeyNames(SECRETS)],
});

let root: Logger | undefined;

/** The root logger. Its records carry the request id when a request caused them. */
export function rootLogger(): Logger {
  root ??= createLogger({ scope: 'app', redactor, context: requestContext });
  return root;
}

/** A logger for Nitro code. Modules get theirs injected and never call this. */
export function useLogger(scope: string, bindings?: Record<string, unknown>): Logger {
  return rootLogger().child(scope, bindings);
}

function requestContext(): Record<string, unknown> | undefined {
  try {
    const reqId = useEvent().context.reqId;
    return typeof reqId === 'string' ? { reqId } : undefined;
  } catch {
    return undefined; // boot, shutdown, jobs and the bot: no request
  }
}
