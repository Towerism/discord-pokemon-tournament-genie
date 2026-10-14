/**
 * Membership and roles are re-checked every 15 minutes (ADR-0004): a member who left the guild or lost the
 * organizer role loses the website on their next request after that.
 */
export default defineEventHandler(async (event) => {
  const path = event.path;
  if (!path.startsWith('/api/') || path.startsWith('/api/setup') || path.startsWith('/api/_auth')) return;
  const session = await getUserSession(event);
  if (!session.user || !session.grant || session.checkedAt === undefined) return;

  const outcome = await useLogin().refresh({ user: session.user, grant: session.grant, checkedAt: session.checkedAt });
  if (outcome.action === 'update') await setUserSession(event, { grant: outcome.grant, checkedAt: outcome.checkedAt });
  if (outcome.action === 'revoke') {
    await clearUserSession(event);
    throw apiError(401, 'session_revoked', 'Your access changed. Log in again.');
  }
  if (outcome.action === 'unavailable') throw apiError(503, 'discord_unavailable', 'Discord could not be reached. Try again in a moment.');
});
