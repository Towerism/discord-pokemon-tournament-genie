export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const eventId = idParam(event, 'eventId');
  await requireDay(event, id, 'edit');
  await handled(() => useEventDays().deleteEvent(id, eventId));
  setResponseStatus(event, 204);
  return null;
});
