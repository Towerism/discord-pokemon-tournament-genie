import { dayPatchBody } from '../../../../shared/schemas';

export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const { principal } = await requireDay(event, id, 'edit');
  const body = await readValid(event, dayPatchBody);
  await handled(() => useEventDays().patchDay(id, body));
  return dayPlanView(id, principal);
});
