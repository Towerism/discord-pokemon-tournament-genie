import { penaltyCsvQuery } from '../../../../shared/schemas';

/** One event's CSV (§6.6), generated on demand and never cached: it names players. */
export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const { principal, requireEvent } = await requirePenaltyDay(event, id);
  const query = penaltyCsvQuery.safeParse(getQuery(event));
  if (!query.success) throw apiError(400, 'invalid_query', 'Expected eventId and an optional voided=0|1.');
  requireEvent(query.data.eventId);
  const voided = query.data.voided === '1';
  const file = await handled(() => usePenalties().csv(id, query.data.eventId, voided));
  useLogger('penalties').info('penalty_csv_downloaded', { dayId: id, eventId: query.data.eventId, voided, userId: principal.userId, rows: file.rows });
  setResponseHeaders(event, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${file.filename}"`,
    'cache-control': 'no-store',
  });
  return file.body;
});
