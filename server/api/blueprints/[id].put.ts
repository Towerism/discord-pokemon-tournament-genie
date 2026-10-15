import { blueprintBody } from '../../../shared/schemas';

export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'configuration' });
  const id = idParam(event);
  const body = await readValid(event, blueprintBody);
  return handled(() => useEventDays().putBlueprint(id, body));
});
