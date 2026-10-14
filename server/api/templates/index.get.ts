export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'configuration' });
  return { templates: useEventDays().listTemplates() };
});
