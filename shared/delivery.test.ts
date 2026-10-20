import { describe, expect, it } from 'vitest';
import { DELIVERY_STATES, TOKEN_SCOPES_HELP, deliverySentence } from './delivery';

describe('the Settings sentence for message delivery', () => {
  it('names the fix for each problem, and says nothing while delivery is off', () => {
    expect(Object.fromEntries(DELIVERY_STATES.map((s) => [s, deliverySentence(s)]))).toEqual({
      off: null,
      waiting_for_bot: 'Discord messages: waiting for the bot to connect.',
      polling: 'Discord messages: Genie is delivering attendance’s messages.',
      token_refused: 'Discord messages: attendance refused this token. Paste a new one.',
      missing_scope: 'Discord messages: this token can’t deliver messages. In attendance, mint a token with both Read the day and Deliver messages, then paste it here.',
      unsupported: 'Discord messages: this attendance doesn’t offer messages yet. Update it to v1.29.0 or later.',
      rejected: 'Discord messages: attendance refused Genie’s request. Check attendance’s version and the token.',
      token_unreadable: 'Discord messages: Genie can’t read the saved token. Check NUXT_VAULT_KEY, or paste the token again.',
      rate_limited: 'Discord messages: attendance can’t be reached; Genie keeps trying.',
      attendance_unreachable: 'Discord messages: attendance can’t be reached; Genie keeps trying.',
    });
  });

  it('tells the organizer the token needs both scopes', () => {
    expect(TOKEN_SCOPES_HELP).toBe('Mint the token in attendance with both scopes: Read the day, for imports, and Deliver messages, for Discord messages.');
  });
});
