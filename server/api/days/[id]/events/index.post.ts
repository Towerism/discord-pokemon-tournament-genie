import { eventCreateBody } from '../../../../../shared/schemas';

export default defineEventHandler(async (event) => {
  const id = idParam(event);
  await requireDay(event, id, 'edit');
  const body = await readValid(event, eventCreateBody);
  setResponseStatus(event, 201);
  return handled(() => useEventDays().addEvent(id, body));
});
