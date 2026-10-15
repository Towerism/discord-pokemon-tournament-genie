import { emptyBody } from '../../../../../../shared/schemas';

/** Retry skipped attachments, after the cap was raised in Settings (§6.5). */
export default defineEventHandler(async (event) => {
  const id = idParam(event);
  await requireDay(event, id, 'closeout');
  await readValid(event, emptyBody.optional());
  const result = await handled(() => useCloseout().retryAttachments(id));
  setResponseStatus(event, 202);
  return result;
});
