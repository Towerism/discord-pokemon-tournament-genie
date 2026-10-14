/** Forgets the attendance connection. Days keep everything already imported. */
export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'settings' });
  useAttendanceConnection().remove();
  setResponseStatus(event, 204);
  return null;
});
