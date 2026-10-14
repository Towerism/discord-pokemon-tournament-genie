/** Re-runs every check live; completes setup (and starts the bot) only when all pass. */
export default defineEventHandler(async (event) => {
  requireSetupIncomplete();
  requireAllowedOrigin(event);
  const session = await requireSetupUnlocked(event);
  await handled(() => useSetup().finish());
  // The owner stays signed in; the wizard unlock is dropped with the rest of the setup state.
  const { user, grant, checkedAt } = session;
  if (user && grant && checkedAt !== undefined) await replaceUserSession(event, { user, grant, checkedAt });
  else await clearUserSession(event);
  return { complete: true };
});
