/** Answers the row, or `{ deleted: true }` when the claim had created it. */
export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'directory' });
  const id = idParam(event);
  return handled(() => useDirectory().rejectClaim(id) ?? { deleted: true });
});
