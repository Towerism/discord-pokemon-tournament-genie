import { catalogPutBody, seasonParam } from '../../../shared/schemas';

export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'configuration' });
  const season = seasonParam.safeParse(decodeURIComponent(getRouterParam(event, 'season') ?? ''));
  if (!season.success) throw apiError(404, 'not_found', 'No such season.');
  const body = await readValid(event, catalogPutBody);
  return handled(() => usePenalties().putCatalog(season.data, body));
});
