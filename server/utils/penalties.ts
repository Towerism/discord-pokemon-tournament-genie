import type { H3Event } from 'h3';
import { canSee, isOrganizer } from '../../shared/access/access';
import type { PenaltyView } from '../modules/penalties';

const forbidden = () => apiError(403, 'forbidden', 'You can’t see this.');

/**
 * The caller and the day's events whose penalties they may manage (ADR-0010): organizers every event, an event head
 * judge their own. An unknown day is 404; a day where they manage nothing is 403.
 */
export async function requirePenaltyDay(event: H3Event, dayId: number) {
  const { principal } = await requirePrincipal(event, { kind: 'website' });
  const plan = await handled(() => useEventDays().plan(dayId));
  const access = isOrganizer(principal.grant) ? undefined : useProvisioning().accessPlan(dayId, principal);
  const manageable = plan.events.filter((e) => canSee(principal, { kind: 'event_penalties', eventId: e.id, action: 'manage' }, access)).map((e) => e.id);
  if (!manageable.length) throw forbidden();
  const requireEvent = (eventId: number) => {
    if (!manageable.includes(eventId)) throw isOrganizer(principal.grant) ? apiError(404, 'not_found', 'No such event.') : forbidden();
  };
  return { principal, plan, manageable, requireEvent };
}

/**
 * A penalty of this day the caller may manage. Anyone else gets the same answer for another event's penalty and for
 * one that doesn't exist, so the route reveals nothing (an organizer gets 404).
 */
export async function requirePenalty(event: H3Event, dayId: number, penaltyId: number) {
  const ctx = await requirePenaltyDay(event, dayId);
  const found = usePenalties().locate(penaltyId);
  if (!found || found.dayId !== dayId || !ctx.manageable.includes(found.penalty.eventId)) {
    throw isOrganizer(ctx.principal.grant) ? apiError(404, 'not_found', 'No such penalty.') : forbidden();
  }
  return { ...ctx, penalty: found.penalty };
}

/** A penalty as the website shows it: the judge's Discord account stays on the server. */
export function penaltyJson(p: PenaltyView) {
  const { judgeDiscordUserId: _judgeDiscordUserId, ...rest } = p;
  return rest;
}
