import { unlockBody } from '../../../shared/schemas';

/** The one-time setup code from the container log unlocks the wizard for this browser (§6.1). */
export default defineEventHandler(async (event) => {
  requireSetupIncomplete();
  requireAllowedOrigin(event);
  rateLimit(event, 'setup');
  const { code } = await readValid(event, unlockBody);
  if (!setupCodeAccepted(code)) throw apiError(403, 'invalid_setup_code', 'That setup code is not the one in the container log.');
  await setUserSession(event, { setup: { bootId } });
  setResponseStatus(event, 204);
  return null;
});
