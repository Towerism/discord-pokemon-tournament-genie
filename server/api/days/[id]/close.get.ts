/** What closing would leave behind (§6.5 step 1): the confirmation lists it. */
export default defineEventHandler(async (event) => {
  const id = idParam(event);
  await requireDay(event, id, 'close');
  return handled(() => useCloseout().preflight(id));
});
