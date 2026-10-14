import type { LogFields, Logger } from '@towerism/selfhost-kit';

export interface LogRecord {
  level: 'error' | 'warn' | 'info' | 'debug';
  scope: string;
  msg: string;
  fields: LogFields | undefined;
}

/** A Logger that keeps its records, for asserting what was (and wasn't) logged. */
export function recordingLogger(scope = 'test', records: LogRecord[] = []): Logger & { records: LogRecord[] } {
  const at =
    (level: LogRecord['level']) =>
    (msg: string, fields?: LogFields): void => {
      records.push({ level, scope, msg, fields });
    };
  return {
    records,
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
    child: (child, bindings) => {
      const logger = recordingLogger(child, records);
      if (!bindings) return logger;
      const wrap =
        (level: LogRecord['level']) =>
        (msg: string, fields?: LogFields): void => {
          records.push({ level, scope: child, msg, fields: { ...bindings, ...fields } });
        };
      return { ...logger, error: wrap('error'), warn: wrap('warn'), info: wrap('info'), debug: wrap('debug') };
    },
  };
}
