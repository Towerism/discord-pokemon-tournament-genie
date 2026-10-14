import { allowlistBody } from '../../../shared/schemas';

/** Owner only (§9). Organizers become `owner ∪ (organizer role ∩ allowlist)` while it is on. */
export default defineEventHandler(async (event) => {
  await requirePrincipal(event, { kind: 'organizer_allowlist' });
  const body = await readValid(event, allowlistBody);
  return useSettings().putAllowlist(body);
});
