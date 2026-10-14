import { staffCreateBody } from '../../../shared/schemas';

export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'directory' });
  const body = await readValid(event, staffCreateBody);
  setResponseStatus(event, 201);
  return handled(() => useDirectory().create(body));
});
