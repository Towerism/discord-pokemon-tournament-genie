/** Organizers only (§7); a head judge finds their days in `GET /api/me` (FR-26). */
export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'days' });
  return { days: useEventDays().listDays() };
});
