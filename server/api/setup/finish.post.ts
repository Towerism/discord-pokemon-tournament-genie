/** Re-runs every check live; completes setup (and starts the bot) only when all pass. */
export default defineEventHandler(async (event) => {
  requireSetupIncomplete();
  requireAllowedOrigin(event);
  await requireSetupUnlocked(event);
  await handled(() => useSetup().finish());
  await setUserSession(event, { setup: undefined });
  return { complete: true };
});
