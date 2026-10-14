import { describe, expect, it } from 'vitest';
import { deriveEffective } from '../../src/s3/effective.js';
import type { Action, Observation } from '../../src/s3/types.js';

type Obs = Partial<Record<Action, Observation>>;
const allChannel = (o: Observation): Obs => ({
  view: o, readHistory: o, reactExisting: o, reactNew: o, createPublicThread: o, createPrivateThread: o, send: o,
});

describe('deriveEffective', () => {
  it('no View means every permission is false', () => {
    const e = deriveEffective({ ...allChannel('allowed'), view: 'denied' }, 'channel');
    expect(Object.values(e).every((v) => v === false)).toBe(true);
  });

  it('maps each channel action to its permission', () => {
    expect(deriveEffective(allChannel('allowed'), 'channel')).toEqual({
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: true,
      SendMessagesInThreads: 'unobservable',
      CreatePublicThreads: true,
      CreatePrivateThreads: true,
      AddReactions: true,
    });
  });

  it('a denied channel send is SendMessages false', () => {
    expect(deriveEffective({ ...allChannel('allowed'), send: 'denied' }, 'channel').SendMessages).toBe(false);
  });

  it('a denied new reaction is AddReactions false only when Read History was allowed', () => {
    expect(deriveEffective({ ...allChannel('allowed'), reactNew: 'denied' }, 'channel').AddReactions).toBe(false);
    expect(
      deriveEffective({ ...allChannel('allowed'), readHistory: 'denied', reactNew: 'denied' }, 'channel').AddReactions,
    ).toBe('unobservable');
  });

  it('on a thread, send is Send Messages in Threads, and channel-only permissions are unobservable', () => {
    const e = deriveEffective({ view: 'allowed', readHistory: 'allowed', reactExisting: 'allowed', reactNew: 'allowed', send: 'allowed' }, 'thread');
    expect(e.SendMessagesInThreads).toBe(true);
    expect(e.SendMessages).toBe('unobservable');
    expect(e.CreatePublicThreads).toBe('unobservable');
    expect(e.CreatePrivateThreads).toBe('unobservable');
  });

  it('a blocked_archived action is unobservable', () => {
    const e = deriveEffective(
      { view: 'allowed', readHistory: 'allowed', reactExisting: 'blocked_archived', reactNew: 'blocked_archived', send: 'denied' },
      'thread',
    );
    expect(e.AddReactions).toBe('unobservable');
    expect(e.SendMessagesInThreads).toBe(false);
  });

  it('reactExisting maps to no permission of its own', () => {
    const a = deriveEffective({ ...allChannel('allowed'), reactExisting: 'denied' }, 'channel');
    const b = deriveEffective(allChannel('allowed'), 'channel');
    expect(a).toEqual(b);
  });

  it('a missing or inconclusive observation is unobservable', () => {
    expect(deriveEffective({ view: 'allowed' }, 'channel').SendMessages).toBe('unobservable');
    expect(deriveEffective({ view: 'inconclusive' }, 'channel').ViewChannel).toBe('unobservable');
  });
});
