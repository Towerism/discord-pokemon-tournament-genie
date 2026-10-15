import { isOrganizer } from '../../../../../../shared/access/access';
import { penaltyVoidBody } from '../../../../../../shared/schemas';

export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const { principal, penalty, plan } = await requirePenalty(event, id, idParam(event, 'pid'));
  const { revision, reason } = await readValid(event, penaltyVoidBody);
  if (plan.day.state === 'closed' || plan.day.state === 'purged') {
    const who = { expectedRevision: revision, by: principal.userId, organizer: isOrganizer(principal.grant) };
    const corrected = await handled(() => useCloseout().correctPenalty(id, penalty.id, { kind: 'void', reason }, who));
    return { penalty: penaltyJson(corrected.penalty), exportFileId: corrected.exportFileId };
  }
  const result = await handled(() => usePenalties().voidPenalty(id, penalty.id, { reason, expectedRevision: revision, by: principal.userId }));
  return { penalty: penaltyJson(result.penalty) };
});
