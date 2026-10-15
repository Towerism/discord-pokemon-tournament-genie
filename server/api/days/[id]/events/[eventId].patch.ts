import { eventPatchBody } from '../../../../../shared/schemas';

export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const eventId = idParam(event, 'eventId');
  await requireDay(event, id, 'edit');
  const body = await readValid(event, eventPatchBody);
  const state = (await handled(() => useEventDays().plan(id))).day.state;
  const onlyTournamentId = Object.keys(body).every((k) => k === 'tournamentId') && body.tournamentId !== undefined;
  // After close the Tournament ID is the one change, and it writes the event's CSVs (§6.6).
  if ((state === 'closed' || state === 'purged') && onlyTournamentId) return handled(() => useCloseout().setTournamentId(id, eventId, body.tournamentId ?? null));
  return handled(() => useEventDays().patchEvent(id, eventId, body));
});
