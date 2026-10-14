export default defineEventHandler(async (event) => {
  const job = await requireJob(event);
  return { job, events: useJobs().events(job.id) };
});
