/** Only a draft (FR-23): an opened day owns Discord channels. */
export default defineEventHandler(async (event) => {
  const id = idParam(event);
  await requireDay(event, id, 'edit');
  await handled(() => useEventDays().deleteDay(id));
  setResponseStatus(event, 204);
  return null;
});
