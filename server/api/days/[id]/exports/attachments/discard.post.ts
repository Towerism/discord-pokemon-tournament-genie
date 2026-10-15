import { discardBody } from '../../../../../../shared/schemas';

/** Discard skipped attachments (§6.5): confirmed, and logged with who, when and which. */
export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const { principal } = await requireDay(event, id, 'closeout');
  const body = await readValid(event, discardBody);
  requireConfirmed(body);
  return handled(() => useCloseout().discard(id, body.attachmentIds, principal.userId));
});
