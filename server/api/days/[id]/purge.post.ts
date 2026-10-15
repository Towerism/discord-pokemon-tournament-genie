import { confirmBody } from '../../../../shared/schemas';

/** "Delete now" (§6.5 step 4): the grace period ends and the purge runs, gated as always. */
export default defineEventHandler(async (event) => {
  const id = idParam(event);
  await requireDay(event, id, 'closeout');
  requireConfirmed(await readValid(event, confirmBody));
  const result = await handled(() => useCloseout().purgeNow(id));
  setResponseStatus(event, 202);
  return result;
});
