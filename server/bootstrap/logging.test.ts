import { describe, expect, it } from 'vitest';
import { redactor as appRedactor } from '../utils/logger';
import { redactor, startupLogger } from './logging';

describe('startupLogger', () => {
  it("hides Genie's secrets in what the launcher logs, and keeps the rest", () => {
    const lines: string[] = [];
    const logger = startupLogger({ write: (line) => lines.push(line) });

    logger.info('starting', { botToken: 'tok-123', NUXT_VAULT_KEY: 'key-456', userId: 'u1' });

    const out = lines.join('');
    expect(out).toContain('u1');
    expect(out).not.toContain('tok-123');
    expect(out).not.toContain('key-456');
  });

  it("uses the redactor the app's loggers and the kit's contract tests use", () => {
    expect(redactor).toBe(appRedactor);
  });
});
