import { type Logger, createLogger } from '@towerism/selfhost-kit';
import { redactor } from '../bootstrap/logging';

/** Genie's redactor, shared with the launcher (see ../bootstrap/logging). */
export { redactor };

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
