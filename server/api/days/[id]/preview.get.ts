/** Organizers and the day's head judges; a head judge sees only the channels Discord shows them. */
export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const { principal } = await requireDay(event, id, 'preview');
  return handled(() => useProvisioning().preview(id, principal));
});
