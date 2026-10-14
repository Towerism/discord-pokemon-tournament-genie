import { PERMISSIONS, type Action, type Effective, type Observation, type PermissionName } from './types.js';

const fromObservation = (o: Observation | undefined): Effective =>
  o === 'allowed' ? true : o === 'denied' ? false : 'unobservable';

/**
 * Derives the seven modelled permissions from observed actions (the Action → permission table).
 * Discord removes every channel permission without View Channel; Create Reaction needs Read
 * Message History, plus Add Reactions for an emoji nobody has used yet.
 */
export function deriveEffective(
  observed: Partial<Record<Action, Observation>>,
  target: 'channel' | 'thread',
): Record<PermissionName, Effective> {
  if (observed.view === 'denied') {
    return Object.fromEntries(PERMISSIONS.map((p) => [p, false])) as Record<PermissionName, Effective>;
  }

  let addReactions = fromObservation(observed.reactNew);
  if (addReactions === false && observed.readHistory !== 'allowed') addReactions = 'unobservable';

  const onChannel = (o: Observation | undefined): Effective => (target === 'channel' ? fromObservation(o) : 'unobservable');
  const onThread = (o: Observation | undefined): Effective => (target === 'thread' ? fromObservation(o) : 'unobservable');

  return {
    ViewChannel: fromObservation(observed.view),
    ReadMessageHistory: fromObservation(observed.readHistory),
    SendMessages: onChannel(observed.send),
    SendMessagesInThreads: onThread(observed.send),
    CreatePublicThreads: onChannel(observed.createPublicThread),
    CreatePrivateThreads: onChannel(observed.createPrivateThread),
    AddReactions: addReactions,
  };
}
