import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { canSee, isOrganizer } from '../../../shared/access/access';
import { CSP_TRANSCRIPT, contentDisposition } from '../../../shared/closeout';

const notInAudience = () => apiError(403, 'not_in_audience', 'You can’t download this file.');

/**
 * One exported file (§6.5 "Serving exports safely"): only the HTML transcript is shown inline, under a sandbox CSP;
 * everything else is a download. Never cached; every download is logged.
 */
export default defineEventHandler(async (event) => {
  const fileId = idParam(event, 'fileId');
  const { principal } = await requirePrincipal(event, { kind: 'website' });
  const organizer = isOrganizer(principal.grant);
  const found = useCloseout().download(fileId);
  // An unknown file answers a non-organizer exactly as one they may not see: IDs reveal nothing.
  if (!found) throw organizer ? apiError(404, 'not_found', 'No such file.') : notInAudience();
  if (!organizer && !canSee(principal, found.resource, await handled(() => useProvisioning().accessPlan(found.dayId, principal)))) throw notInAudience();
  if (!found.path) throw apiError(404, 'not_found', 'No such file.');
  const onDisk = await stat(found.path).catch(() => null);
  if (!onDisk?.isFile()) throw apiError(404, 'not_found', 'The file is missing from the exports folder. Re-export the day.');

  const { file } = found;
  const headers: Record<string, string> = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (file.kind === 'transcript_html' || file.kind === 'thread_transcript_html') {
    Object.assign(headers, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP_TRANSCRIPT, 'content-disposition': contentDisposition(file.downloadName, 'inline') });
  } else if (file.kind === 'penalties_csv' || file.kind === 'penalties_voided_csv') {
    Object.assign(headers, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': contentDisposition(file.downloadName) });
  } else {
    const json = file.kind === 'transcript_json' || file.kind === 'thread_transcript_json';
    Object.assign(headers, { 'content-type': json ? 'application/json' : 'application/octet-stream', 'content-disposition': contentDisposition(file.downloadName) });
  }
  setResponseHeaders(event, headers);
  const stream = createReadStream(found.path);
  // A download the client abandons releases its file at once.
  event.node.res.once('close', () => stream.destroy());
  useLogger('closeout').info('export_downloaded', { fileId, kind: file.kind, dayId: found.dayId, userId: principal.userId });
  return sendStream(event, stream);
});
