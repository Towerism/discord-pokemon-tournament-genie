import { isOrganizer } from '../../../../../shared/access/access';

/** The day's exported files the caller may see (§6.5, ADR-0010), with what organizers act on. */
export default defineEventHandler(async (event) => {
  const id = idParam(event);
  const { principal } = await requireDay(event, id, 'read');
  if (isOrganizer(principal.grant)) return handled(() => useCloseout().exportsView(id, null));
  return handled(() => useCloseout().exportsView(id, principal, useProvisioning().accessPlan(id, principal)));
});
