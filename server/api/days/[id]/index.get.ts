export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const { principal } = await requireDay(event, id, 'read');
  return dayPlanView(id, principal);
});
