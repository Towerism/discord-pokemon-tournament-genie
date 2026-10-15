import { confirmBody } from '../../../../shared/schemas';

/** Close the day (§6.5): organizers and the day's head judges. 202 with the lock job. */
export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const { principal } = await requireDay(event, id, 'close');
  requireConfirmed(await readValid(event, confirmBody));
  const result = await handled(() => useCloseout().close(id, principal.userId));
  setResponseStatus(event, 202);
  return result;
});
