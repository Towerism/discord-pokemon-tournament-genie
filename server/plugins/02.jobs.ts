import { startJobTimer, systemScheduler } from '../modules/jobs/timer';

/**
 * Boot recovery, then the due-work timer (§10). The provisioning handlers are registered first, so interrupted
 * syncs are queued again, and every open day whose removals may not have landed gets a sync.
 * Shutdown waits for running handlers.
 */
export default defineNitroPlugin((nitroApp) => {
  const jobs = useJobs();
  const provisioning = useProvisioning();
  provisioning.register();
  jobs.recover();
  provisioning.recoverOnBoot();
  const stop = startJobTimer({ jobs, scheduler: systemScheduler, logger: useLogger('jobs') });
  nitroApp.hooks.hook('close', stop);
});
