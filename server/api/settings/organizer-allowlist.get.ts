/** Owner only (§9). */
export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'organizer_allowlist' });
  return useSettings().allowlist();
});
