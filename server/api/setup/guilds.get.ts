/** The servers the bot has been invited to. */
export default defineEventHandler(async (event) => {
  requireSetupIncomplete();
  await requireSetupUnlocked(event);
  return { guilds: await handled(() => useSetup().guilds()) };
});
