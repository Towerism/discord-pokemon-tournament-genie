import { startJobTimer, systemScheduler } from '../modules/jobs/timer';

/** Boot recovery, then the due-work timer (§10). Shutdown waits for running handlers. */
export default defineNitroPlugin((nitroApp) => {
  const jobs = useJobs();
  jobs.recover();
  const stop = startJobTimer({ jobs, scheduler: systemScheduler, logger: useLogger('jobs') });
  nitroApp.hooks.hook('close', stop);
});
