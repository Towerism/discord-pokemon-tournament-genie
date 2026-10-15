import { closeOutSettingsBody } from '../../../shared/schemas';

/** Retention and the attachment cap (§6.5, §15 Q3); transcripts must outlive the grace period. */
export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'settings' });
  const body = await readValid(event, closeOutSettingsBody);
  return handled(() => useCloseout().putSettings(body));
});
