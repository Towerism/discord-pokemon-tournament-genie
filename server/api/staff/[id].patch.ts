import { staffPatchBody } from '../../../shared/schemas';

/** A relink or unlink of someone on an open day queues a removal sync. */
export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'directory' });
  const id = idParam(event);
  const body = await readValid(event, staffPatchBody);
  return handled(() => useDirectory().update(id, body));
});
