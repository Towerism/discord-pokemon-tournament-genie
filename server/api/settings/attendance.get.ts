/** The attendance connection: its address and a hint of the token, never the token (§4.2, §9). */
export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'settings' });
  return handled(() => useAttendanceConnection().view());
});
