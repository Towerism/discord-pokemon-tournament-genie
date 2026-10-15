export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'settings' });
  return { ...(await handled(() => useSettings().settings())), closeOut: useCloseout().settings() };
});
