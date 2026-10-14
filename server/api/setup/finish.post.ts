/** Re-runs every check live; completes setup (and starts the bot) only when all pass. */
export default defineEventHandler(async (event) => {
  requireSetupIncomplete();
  requireAllowedOrigin(event);
  const session = await requireSetupUnlocked(event);
  await handled(() => useSetup().finish());
  // The owner stays signed in; the wizard unlock is dropped with the rest of the setup state. Anyone else who
  // finished (a second browser that holds the code but was rebound away from owner) is signed out.
  const { user, checkedAt } = session;
  if (user && checkedAt !== undefined && user.id === useSetup().progress().ownerId) {
    await replaceUserSession(event, { user, grant: 'owner', checkedAt });
  } else {
    await clearUserSession(event);
  }
  return { complete: true };
});
