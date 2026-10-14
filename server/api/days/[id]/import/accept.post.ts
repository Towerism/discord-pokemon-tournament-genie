import { importAcceptBody } from '../../../../../shared/schemas';

/** Applies the chosen items of the day's latest pull in one transaction; removals sync at once (§4.2, §6.3). */
export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const { principal } = await requireDay(event, id, 'edit');
  const body = await readValid(event, importAcceptBody);
  const { applied, syncJobId } = await handled(() => useAttendanceImport().accept(id, body));
  return { plan: await dayPlanView(id, principal), applied, syncJobId };
});
