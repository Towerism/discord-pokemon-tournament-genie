import { memberQuery } from '../../../shared/schemas';

/** The member picker: humans only, with the staff row already linked to each. */
export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'members' });
  const parsed = memberQuery.safeParse(getQuery(event));
  if (!parsed.success) throw apiError(400, 'invalid_body', 'Search with 1 to 32 characters.', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  const guildId = useBoundGuildId();
  if (!guildId) throw apiError(409, 'setup_incomplete', 'Finish setup first.');
  return discordCall(async () => {
    const found = await useCreateDiscord()(useSetup().botToken()).gateway.searchMembers(guildId, parsed.data.q, 25);
    return {
      members: found
        .filter((m) => !m.bot)
        .map((m) => ({ userId: m.userId, displayName: m.displayName, username: m.username, staffMemberId: useDirectory().byDiscordUser(m.userId)?.id ?? null })),
    };
  });
});
