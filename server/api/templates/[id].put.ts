import { templateBody } from '../../../shared/schemas';

export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'configuration' });
  const id = idParam(event);
  const body = await readValid(event, templateBody);
  return handled(() => useEventDays().putTemplate(id, body));
});
