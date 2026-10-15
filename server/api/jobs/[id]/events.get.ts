/** The job's events as server-sent events, from `Last-Event-ID` on, ending once the job is done. */
export default defineEventHandler(async (event) => {
  const { job, visible } = await requireJob(event);
  const stream = createEventStream(event);
  let after = Number(getRequestHeader(event, 'last-event-id') ?? 0) || 0;
  let open = true;
  const terminal = new Set(['succeeded', 'failed', 'interrupted']);
  const pump = async () => {
    while (open) {
      for (const e of useJobs().events(job.id)) {
        if (e.id <= after) continue;
        await stream.push({ id: String(e.id), data: JSON.stringify(visible(e)) });
        after = e.id;
      }
      const current = useJobs().get(job.id);
      if (!current || terminal.has(current.state)) {
        // A last read: events written while the state changed.
        for (const e of useJobs().events(job.id)) if (e.id > after) await stream.push({ id: String(e.id), data: JSON.stringify(visible(e)) });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await stream.close();
  };
  stream.onClosed(() => {
    open = false;
  });
  pump().catch(() => {
    open = false;
  });
  return stream.send();
});
