export default defineEventHandler(async (event) => {
  const id = idParam(event);
  await requireDay(event, id, 'sync');
  const result = await handled(() => useProvisioning().sync(id));
  setResponseStatus(event, 202);
  return result;
});
