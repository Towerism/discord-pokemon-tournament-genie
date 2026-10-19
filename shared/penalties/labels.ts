/**
 * What the penalties page shows for a penalty's Discord card. Imports nothing, so the browser bundle gains only
 * this table; a unit test keeps its keys equal to the states the database stores.
 */
export type CardState = 'pending' | 'posted' | 'failed' | 'missing' | 'none';

export const CARD_STATE_LABELS: Record<CardState, string> = {
  pending: 'Posting',
  posted: 'Posted',
  failed: 'Failed',
  missing: 'Deleted in Discord',
  // Set when the event had no penalty channel to post in.
  none: 'No channel',
};

export const cardStateLabel = (state: CardState): string => CARD_STATE_LABELS[state];
