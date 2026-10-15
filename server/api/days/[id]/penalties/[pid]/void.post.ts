import { penaltyVoidBody } from '../../../../../../shared/schemas';

export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const { principal, penalty } = await requirePenalty(event, id, idParam(event, 'pid'));
  const { revision, reason } = await readValid(event, penaltyVoidBody);
  const result = await handled(() => usePenalties().voidPenalty(id, penalty.id, { reason, expectedRevision: revision, by: principal.userId }));
  return { penalty: penaltyJson(result.penalty) };
});
