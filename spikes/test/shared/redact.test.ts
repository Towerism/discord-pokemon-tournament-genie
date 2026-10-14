import { describe, expect, it } from 'vitest';
import { createRedactor } from '../../src/shared/redact.js';

describe('createRedactor', () => {
  // Assembled at runtime so no token-shaped literal is ever committed (secret scanners would flag it).
  const secret = ['MTIz', 'NDU2Nzg5MDEyMzQ1Njc4', 'Gabcde', 'abcdefghijklmnopqrstuvwxyz0'].join('.').replace('MTIz.', 'MTIz');
  const redact = createRedactor([secret, 'clientsecretvalue']);

  it('masks every configured secret value', () => {
    const out = redact(`Authorization: Bot ${secret} and clientsecretvalue`);
    expect(out).not.toContain(secret);
    expect(out).not.toContain('clientsecretvalue');
  });

  it('masks interaction and webhook tokens in API paths', () => {
    const out = redact(
      'POST /api/v10/interactions/1300000000000000000/aW50ZXJhY3Rpb246dG9rZW4/callback and /webhooks/1300000000000000002/abc-DEF_123',
    );
    expect(out).toContain('/interactions/1300000000000000000/[redacted]');
    expect(out).toContain('/webhooks/1300000000000000002/[redacted]');
    expect(out).not.toContain('aW50ZXJhY3Rpb246dG9rZW4');
    expect(out).not.toContain('abc-DEF_123');
  });

  it('masks OAuth code and state query values', () => {
    const out = redact('GET /auth/discord?code=AbC123xyz&state=deadbeef&other=1');
    expect(out).toBe('GET /auth/discord?code=[redacted]&state=[redacted]&other=1');
  });

  it('leaves ordinary text alone', () => {
    expect(redact('case R4-default-locked-staffer passed')).toBe('case R4-default-locked-staffer passed');
  });

  it('ignores empty secrets instead of masking everything', () => {
    expect(createRedactor([''])('hello')).toBe('hello');
  });
});
