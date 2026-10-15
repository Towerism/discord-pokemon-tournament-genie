import { dayCreateBody } from '../../../shared/schemas';

export default defineEventHandler(async (event) => {
  const { principal } = await requirePrincipal(event, { kind: 'day_create' });
  const body = await readValid(event, dayCreateBody);
  const created = await handled(() => useEventDays().createDay(body));
  setResponseStatus(event, 201);
  return dayPlanView(created.day.id, principal);
});
