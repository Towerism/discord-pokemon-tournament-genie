import { canSee, isOrganizer } from '../../../../shared/access/access';

/** What closing would leave behind (§6.5 step 1): the confirmation lists it, each penalty only to who may manage it. */
export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const { principal } = await requireDay(event, id, 'close');
  const preflight = await handled(() => useCloseout().preflight(id));
  if (isOrganizer(principal.grant)) return preflight;
  const access = useProvisioning().accessPlan(id, principal);
  return { ...preflight, recentPenalties: preflight.recentPenalties.filter((p) => canSee(principal, { kind: 'event_penalties', eventId: p.eventId, action: 'manage' }, access)) };
});
