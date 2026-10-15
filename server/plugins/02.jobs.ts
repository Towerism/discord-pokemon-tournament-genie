import { startJobTimer, systemScheduler } from '../modules/jobs/timer';

/**
 * Boot recovery, then the due-work timer (§10). The provisioning and close-out handlers are registered first, so
 * interrupted syncs and close-out jobs are queued again, and every open or closing day whose removals may not have
 * landed gets a sync. The daily retention sweep is scheduled.
 * Shutdown waits for running handlers.
 */
export default defineNitroPlugin((nitroApp) => {
  const jobs = useJobs();
  const provisioning = useProvisioning();
  const closeout = useCloseout();
  provisioning.register();
  closeout.register();
  // Export runs a stop cut short are failed before their jobs are queued again.
  closeout.recoverOnBoot();
  jobs.recover();
  provisioning.recoverOnBoot();
  const stop = startJobTimer({ jobs, scheduler: systemScheduler, logger: useLogger('jobs') });
  nitroApp.hooks.hook('close', stop);
});
