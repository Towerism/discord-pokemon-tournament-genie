import { randomBytes } from 'node:crypto';
import { createVault } from '@towerism/selfhost-kit';
import { securityHeadersPlugin } from '@towerism/selfhost-kit/nitro';
import {
  describeBodySize,
  describeJsonOnly,
  describeRedactionContract,
  describeSecurityHeaders,
  describeVaultContract,
} from '@towerism/selfhost-kit/testing';
import { describe } from 'vitest';
import { EXTRA_CSP } from '../../shared/csp';
import jsonOnlyMiddleware from '../../server/middleware/01.json-only';
import bodySizeMiddleware, { MAX_BODY_BYTES } from '../../server/middleware/02.body-size';
import { redactor } from '../../server/utils/logger';

// Genie runs the kit's contract suites against its own configuration (architecture §11); the kit's own unit
// tests aren't repeated here.

describe('JSON-only CSRF guard, as Genie wires it', () => {
  describeJsonOnly(jsonOnlyMiddleware);
});

describe('body size limit, as Genie wires it', () => {
  describeBodySize(bodySizeMiddleware, { maxBytes: MAX_BODY_BYTES });
});

describe.each([true, false])('security headers, as Genie wires them (https site: %s)', (httpsSite) => {
  describeSecurityHeaders(securityHeadersPlugin({ siteUrl: httpsSite ? 'https://genie.example' : '', extraCsp: EXTRA_CSP, nuxtSecurity: false }), {
    httpsSite,
    extraCsp: EXTRA_CSP,
  });
});

describe("Genie's vault", () => {
  const key = randomBytes(32).toString('base64');
  describeVaultContract('vault', () => createVault({ key, label: 'vault' }));
});

describe("Genie's log redaction", () => {
  describeRedactionContract(redactor, {
    mustHide: ['botToken', 'clientSecret', 'attendanceToken', 'content', 'notes', 'competitorPlayerId', 'voidReason', 'requestBody', 'NUXT_VAULT_KEY', 'NUXT_SESSION_PASSWORD', 'vaultKey'],
    mustShow: ['dayId', 'jobId', 'kind', 'guildId', 'tokenCount', 'userId', 'grant', 'penaltyId', 'eventId', 'reason'],
  });
});
