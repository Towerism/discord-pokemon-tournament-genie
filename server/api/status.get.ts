/** The bot's state for the page header (§10): connection, latency, missing permissions, other guilds. */
export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'settings' });
  return useBot().status();
});
