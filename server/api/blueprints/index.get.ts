export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'configuration' });
  return { blueprints: useEventDays().listBlueprints() };
});
