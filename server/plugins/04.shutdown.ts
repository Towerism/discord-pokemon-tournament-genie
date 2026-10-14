/** Last on shutdown, after jobs and the bot have stopped: checkpoint the WAL and close the database. */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('close', () => closeDatabase());
});
