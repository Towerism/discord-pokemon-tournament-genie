/**
 * The bot's state for the page header (§10): connection, latency, missing permissions, other guilds; and the
 * "access not yet revoked" alarms of open days whose removal sync hasn't landed, and close-out's failed jobs and
 * refused purges (§6.5 "Where alerts go").
 */
export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'settings' });
  return { ...(await useBot().status()), alarms: [...useProvisioning().alarms(), ...useCloseout().alarms()] };
});
