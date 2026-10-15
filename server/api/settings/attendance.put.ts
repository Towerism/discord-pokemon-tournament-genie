import { attendanceConnectionBody } from '../../../shared/schemas';

/** Saves where attendance answers and the token, sealed (§4.2, §9). The body holds a secret: allowed origins only (ADR-0013). */
export default defineEventHandler(async (event) => {
  requireAllowedOrigin(event);
  await requirePrincipal(event, { kind: 'settings' });
  const body = await readValid(event, attendanceConnectionBody);
  return handled(() => useAttendanceConnection().put(body));
});
