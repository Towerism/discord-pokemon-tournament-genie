import { templateBody } from '../../../shared/schemas';

export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'configuration' });
  const body = await readValid(event, templateBody);
  setResponseStatus(event, 201);
  return handled(() => useEventDays().createTemplate(body));
});
