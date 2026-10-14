export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'settings' });
  return useSettings().settings();
});
