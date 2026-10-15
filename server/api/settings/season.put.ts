import { seasonPutBody } from '../../../shared/schemas';

export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'settings' });
  const { season, copyFrom } = await readValid(event, seasonPutBody);
  return handled(() => usePenalties().setSeason(season, copyFrom));
});
