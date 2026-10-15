import { catalogQuery } from '../../../shared/schemas';

export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'configuration' });
  const query = catalogQuery.safeParse(getQuery(event));
  if (!query.success) throw apiError(404, 'not_found', 'No such season.');
  return handled(() => usePenalties().catalog(query.data.season));
});
