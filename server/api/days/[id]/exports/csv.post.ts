import { emptyBody } from '../../../../../shared/schemas';

/** Rewrite CSVs: every event's CSVs written again (after a correction's write failed, say). */
export default defineEventHandler(async (event) => {
  const id = idParam(event);
  await requireDay(event, id, 'closeout');
  await readValid(event, emptyBody.optional());
  const result = await handled(() => useCloseout().rewriteCsvs(id));
  setResponseStatus(event, 202);
  return result;
});
