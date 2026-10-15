export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'directory' });
  const id = idParam(event);
  return handled(() => useDirectory().confirmClaim(id).staff);
});
