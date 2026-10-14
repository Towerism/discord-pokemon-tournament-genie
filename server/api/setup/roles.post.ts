import { rolesBody } from '../../../shared/schemas';

/** The owner maps Discord roles to Genie's organizer and head-judge permissions (§9). */
export default defineEventHandler(async (event) => {
  requireSetupIncomplete();
  requireAllowedOrigin(event);
  const session = await requireSetupUnlocked(event);
  const body = await readValid(event, rolesBody);
  return handled(() => useSetup().mapRoles(session.user?.id ?? null, body));
});
