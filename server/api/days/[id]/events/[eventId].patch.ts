import { eventPatchBody } from '../../../../../shared/schemas';

export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const eventId = idParam(event, 'eventId');
  await requireDay(event, id, 'edit');
  const body = await readValid(event, eventPatchBody);
  return handled(() => useEventDays().patchEvent(id, eventId, body));
});
