export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const { plan, manageable } = await requirePenaltyDay(event, id);
  const penalties = usePenalties();
  return {
    events: plan.events
      .filter((e) => manageable.includes(e.id))
      .map((e) => ({ id: e.id, name: e.name, game: e.game, tournamentId: e.tournamentId, judges: penalties.judges(id, e.id), options: penalties.options(id, e.id) })),
    penalties: penalties.list(id, manageable).map(penaltyJson),
  };
});
