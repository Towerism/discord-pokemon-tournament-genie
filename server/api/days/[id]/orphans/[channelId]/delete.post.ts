export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const { principal } = await requireDay(event, id, 'edit');
  const channelId = snowflakeParam(event, 'channelId');
  await handled(() => useProvisioning().deleteOrphan(id, channelId));
  return dayPlanView(id, principal);
});
