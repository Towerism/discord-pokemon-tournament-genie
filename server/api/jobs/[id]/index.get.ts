export default defineEventHandler(async (event) => {
  const { job, visible } = await requireJob(event);
  return { job, events: useJobs().events(job.id).map(visible) };
});
