import { discordBody } from '../../../shared/schemas';

/** The Discord application: verified live, then sealed in the vault (§4.1, §6.1). */
export default defineEventHandler(async (event) => {
  requireSetupIncomplete();
  requireAllowedOrigin(event);
  await requireSetupUnlocked(event);
  const body = await readValid(event, discordBody);
  return handled(() => useSetup().saveDiscord(body));
});
