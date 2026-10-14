import { staffPutBody } from '../../../../shared/schemas';

/** Full replace; a change that takes access away from an open day queues a sync at once. */
export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const { principal } = await requireDay(event, id, 'edit');
  const body = await readValid(event, staffPutBody);
  const { diff, syncJobId } = await handled(() => useEventDays().putStaff(id, body.staff));
  return { diff, syncJobId, plan: await dayPlanView(id, principal) };
});
