import { blueprintBody } from '../../../shared/schemas';

export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'configuration' });
  const body = await readValid(event, blueprintBody);
  setResponseStatus(event, 201);
  return handled(() => useEventDays().createBlueprint(body));
});
