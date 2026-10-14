export default defineEventHandler(async (event) => {
  const id = idParam(event);
  await requireDay(event, id, 'open');
  const result = await handled(() => useProvisioning().open(id));
  setResponseStatus(event, 202);
  return result;
});
