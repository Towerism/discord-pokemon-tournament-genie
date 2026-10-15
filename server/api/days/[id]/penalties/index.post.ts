import { penaltyCreateBody } from '../../../../../shared/schemas';

export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const { principal, requireEvent } = await requirePenaltyDay(event, id);
  const { idempotencyKey, ...body } = await readValid(event, penaltyCreateBody);
  requireEvent(body.eventId);
  const { penalty, created } = await handled(() => usePenalties().record({ ...body, dayId: id, key: `web:${idempotencyKey}`, recordedBy: principal.userId }));
  setResponseStatus(event, created ? 201 : 200);
  return { penalty: penaltyJson(penalty), created };
});
