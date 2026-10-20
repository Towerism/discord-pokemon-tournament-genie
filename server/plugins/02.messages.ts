/**
 * Attendance's Discord messages (ADR-0017): the poller starts at boot and polls once setup is done, a connection is
 * saved and the bot is connected. Its `close` hook is registered before the bot's (`03.bot.ts`), and Nitro runs them
 * in that order, so the poll stops before the bot logs out and the database closes.
 */
export default defineNitroPlugin((nitroApp) => {
  useMessageDelivery().start();
  nitroApp.hooks.hook('close', () => useMessageDelivery().stop());
});
