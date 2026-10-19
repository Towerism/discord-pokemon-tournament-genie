import { describe, expect, it } from 'vitest';
import { CARD_STATES } from '../../server/db/schema';
import { CARD_STATE_LABELS, cardStateLabel } from './labels';

describe('cardStateLabel', () => {
  it('names each stored card state in words a head judge reads', () => {
    expect(CARD_STATES.map(cardStateLabel)).toEqual(['Posting', 'Posted', 'Failed', 'Deleted in Discord', 'No channel']);
  });

  it('labels exactly the card states the database stores, so a new state needs a label', () => {
    expect(Object.keys(CARD_STATE_LABELS).sort()).toEqual([...CARD_STATES].sort());
  });
});
