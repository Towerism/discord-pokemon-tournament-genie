/**
 * The attendance connection: its address and a hint of the token, never the token (§4.2, §9), and whether Genie is
 * delivering attendance's Discord messages (ADR-0017). No message content or player ID is ever answered.
 */
export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'settings' });
  return handled(() => ({ ...useAttendanceConnection().view(), delivery: useMessageDelivery().status() }));
});
