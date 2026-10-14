import { guildBody } from '../../../shared/schemas';

export default defineEventHandler(async (event) => {
  requireSetupIncomplete();
  requireAllowedOrigin(event);
  await requireSetupUnlocked(event);
  const { guildId } = await readValid(event, guildBody);
  return handled(() => useSetup().chooseGuild(guildId));
});
