import { penaltyPatchBody } from '../../../../../shared/schemas';

export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const { principal, penalty } = await requirePenalty(event, id, idParam(event, 'pid'));
  const { revision, ...patch } = await readValid(event, penaltyPatchBody);
  const result = await handled(() => usePenalties().edit(id, penalty.id, patch, { expectedRevision: revision, by: principal.userId }));
  return { penalty: penaltyJson(result.penalty) };
});
