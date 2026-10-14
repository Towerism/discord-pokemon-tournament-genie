/** The bot logs in at boot once setup is complete, and out on shutdown (§10). Failures never stop the site. */
export default defineNitroPlugin((nitroApp) => {
  if (useSetup().isComplete()) void useBot().start();
  nitroApp.hooks.hook('close', () => useBot().stop());
});
