import { adoptBody } from '../../../../../../shared/schemas';

export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const { principal } = await requireDay(event, id, 'edit');
  const channelId = getRouterParam(event, 'channelId') ?? '';
  const body = await readValid(event, adoptBody);
  await handled(() => useProvisioning().adoptOrphan(id, channelId, body));
  return dayPlanView(id, principal);
});
