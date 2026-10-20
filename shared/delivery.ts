/** Message delivery's state as Settings shows it (issue #51): the server's names and the organizer's sentence. */

export const DELIVERY_STATES = [
  'off',
  'waiting_for_bot',
  'polling',
  'token_refused',
  'missing_scope',
  'unsupported',
  'rejected',
  'token_unreadable',
  'rate_limited',
  'attendance_unreachable',
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

const UNREACHABLE = 'Discord messages: attendance can’t be reached; Genie keeps trying.';

const SENTENCES: Record<DeliveryState, string | null> = {
  off: null,
  waiting_for_bot: 'Discord messages: waiting for the bot to connect.',
  polling: 'Discord messages: Genie is delivering attendance’s messages.',
  token_refused: 'Discord messages: attendance refused this token. Paste a new one.',
  missing_scope: 'Discord messages: this token can’t deliver messages. In attendance, mint a token with both Read the day and Deliver messages, then paste it here.',
  unsupported: 'Discord messages: this attendance doesn’t offer messages yet. Update it to v1.29.0 or later.',
  rejected: 'Discord messages: attendance refused Genie’s request. Check attendance’s version and the token.',
  token_unreadable: 'Discord messages: Genie can’t read the saved token. Check NUXT_VAULT_KEY, or paste the token again.',
  rate_limited: UNREACHABLE,
  attendance_unreachable: UNREACHABLE,
};

/** The sentence under the attendance connection, with the fix for a problem; `null` when there is nothing to say. */
export function deliverySentence(state: DeliveryState): string | null {
  return SENTENCES[state];
}

/** The token field's help: one token serves both the day import and message delivery. */
export const TOKEN_SCOPES_HELP = 'Mint the token in attendance with both scopes: Read the day, for imports, and Deliver messages, for Discord messages.';
