export default defineEventHandler(async (event) => {
  requireSetupIncomplete();
  requireAllowedOrigin(event);
  await requireSetupUnlocked(event);
  return handled(() => useSetup().check());
});
