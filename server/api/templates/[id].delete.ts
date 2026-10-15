export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'configuration' });
  const id = idParam(event);
  await handled(() => useEventDays().deleteTemplate(id));
  setResponseStatus(event, 204);
  return null;
});
