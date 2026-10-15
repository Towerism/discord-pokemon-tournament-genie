/** Pulls the day from attendance and answers what would change, to accept item by item (§4.2). */
export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const { principal } = await requireDay(event, id, 'edit');
  return handled(() => useAttendanceImport().pull(id, principal.userId));
});
