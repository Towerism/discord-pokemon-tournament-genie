import { emptyBody } from '../../../../shared/schemas';

/** Re-export the closed day (§6.5): for messages newer than the marks, or files that changed on disk. */
export default defineEventHandler(async (event) => {
  const id = idParam(event);
  await requireDay(event, id, 'closeout');
  await readValid(event, emptyBody.optional());
  const result = await handled(() => useCloseout().reexport(id));
  setResponseStatus(event, 202);
  return result;
});
