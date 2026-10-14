/**
 * The bot's state for the page header (§10): connection, latency, missing permissions, other guilds; and the
 * "access not yet revoked" alarms of open days whose removal sync hasn't landed (FR-40).
 */
export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'settings' });
  return { ...(await useBot().status()), alarms: useProvisioning().alarms() };
});
