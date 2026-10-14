export default defineEventHandler(async (event) => {
  requireSetupIncomplete();
  await requireSetupUnlocked(event);
  return { roles: await handled(() => useSetup().roles()) };
});
