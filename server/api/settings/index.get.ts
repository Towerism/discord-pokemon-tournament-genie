export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'settings' });
  return handled(() => useSettings().settings());
});
