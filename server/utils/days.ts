import type { H3Event } from 'h3';
import { type Principal, canSee, isOrganizer } from '../../shared/access/access';
import { DiscordAuthError, DiscordUnavailableError } from '../modules/discord/port';
import type { JobEventView } from '../modules/jobs/jobs';

/** The day plan as the API answers it: the plan, its latest job, Genie's channels and orphans, what the caller may do. */
export async function dayPlanView(dayId: number, principal: Principal) {
  const core = await handled(() => useEventDays().plan(dayId));
  const access = isOrganizer(principal.grant) ? null : useProvisioning().accessPlan(dayId, principal);
  const may = (action: 'edit' | 'open' | 'sync') => canSee(principal, { kind: 'day', action }, access ?? undefined);
  return {
    ...core,
    latestJob: useJobs().latestForDay(dayId),
    channels: useProvisioning().channels(dayId),
    orphans: useProvisioning().orphans(dayId),
    can: { edit: may('edit'), open: may('open'), sync: may('sync') },
  };
}

/**
 * A job the caller may read: as its day; a job without a day is organizer only. `visible` hides event data (user
 * IDs, per-channel detail) from non-organizers, as the preview does.
 */
export async function requireJob(event: H3Event) {
  const id = idParam(event);
  const { principal } = await requirePrincipal(event, { kind: 'website' });
  const job = useJobs().get(id);
  if (!job) throw apiError(404, 'not_found', 'No such job.');
  if (job.dayId === null) {
    if (!isOrganizer(principal.grant)) throw apiError(403, 'forbidden', 'You can’t see this.');
  } else {
    await requireDay(event, job.dayId, 'read');
  }
  const organizer = isOrganizer(principal.grant);
  const visible = (e: JobEventView): JobEventView => (organizer ? e : { ...e, data: null });
  return { job, visible };
}

/** A Discord call from a route: an outage is 503, never a 500. */
export async function discordCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DiscordUnavailableError || err instanceof DiscordAuthError) {
      throw apiError(503, 'discord_unavailable', 'Discord could not be reached. Try again in a moment.');
    }
    throw err;
  }
}
