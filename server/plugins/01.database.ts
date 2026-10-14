/** Boot: open and migrate SQLite, then print the setup code while setup is incomplete. */
export default defineNitroPlugin(() => {
  useDatabase();
  announceSetupCode();
});
