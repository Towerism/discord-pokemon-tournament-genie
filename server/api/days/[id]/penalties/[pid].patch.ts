import { isOrganizer } from '../../../../../shared/access/access';
import { penaltyPatchBody } from '../../../../../shared/schemas';

export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const { principal, penalty, plan } = await requirePenalty(event, id, idParam(event, 'pid'));
  const { revision, ...patch } = await readValid(event, penaltyPatchBody);
  if (plan.day.state === 'closed' || plan.day.state === 'purged') {
    // After close, only organizers correct, and each correction writes the event's CSVs again (§6.4).
    const who = { expectedRevision: revision, by: principal.userId, organizer: isOrganizer(principal.grant) };
    const corrected = await handled(() => useCloseout().correctPenalty(id, penalty.id, { kind: 'edit', patch }, who));
    return { penalty: penaltyJson(corrected.penalty), exportFileId: corrected.exportFileId };
  }
  const result = await handled(() => usePenalties().edit(id, penalty.id, patch, { expectedRevision: revision, by: principal.userId }));
  return { penalty: penaltyJson(result.penalty) };
});
