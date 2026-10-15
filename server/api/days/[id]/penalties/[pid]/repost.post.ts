import { emptyBody } from '../../../../../../shared/schemas';

export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const { penalty } = await requirePenalty(event, id, idParam(event, 'pid'));
  await readValid(event, emptyBody);
  return { penalty: penaltyJson(await handled(() => usePenalties().repost(id, penalty.id))) };
});
