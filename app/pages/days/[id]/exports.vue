<script setup lang="ts">
// A closed day's exports (§6.5): the penalty CSVs, a transcript of every channel and thread, their attachments, and
// for organizers what holds the purge up. Every file is served by /api/exports/{id}, which decides who may have it.
type Kind = 'penalties_csv' | 'penalties_voided_csv' | 'transcript_json' | 'transcript_html' | 'thread_transcript_json' | 'thread_transcript_html' | 'attachment';
interface FileView {
  id: number;
  kind: Kind;
  name: string;
  downloadName: string;
  bytes: number;
  createdAt: number;
  supersededBy: number | null;
}
interface Transcript {
  channelId: string;
  threadId: string | null;
  name: string;
  json: FileView;
  html: FileView;
  supersededVersions: { json: FileView; html: FileView }[];
  attachments: { id: number; filename: string; declaredBytes: number; state: 'saved' | 'skipped' | 'discarded'; reason: string | null; fileId: number | null }[];
}
type Reason =
  | { code: 'no_export' | 'content_intent_missing' }
  | { code: 'hash_mismatch' | 'file_missing'; name: string }
  | { code: 'newer_messages' | 'unexported_thread' | 'unexported_channel'; name: string }
  | { code: 'skipped_attachments'; count: number };
interface Exports {
  day: { id: number; title: string; date: string; state: string; closedAt: number | null; graceUntil: number | null; purgedAt: number | null };
  csvs: { eventId: number; eventName: string; files: FileView[] }[];
  transcripts: (Transcript & { threads: Transcript[] })[];
  swept: { transcriptsAt: number | null; penaltiesAt: number | null };
  organizer?: {
    refusal: { at: number; reasons: Reason[] } | null;
    csvBlocked: { eventId: number; name: string }[];
    skipped: { id: number; filename: string; reason: string; transcriptName: string }[];
    latestJob: { kind: string; state: string; error: string | null } | null;
    contentIntentMissing: boolean;
  };
}

const route = useRoute();
const dayId = Number(route.params.id);
const { data, refresh } = await useFetch<Exports>(`/api/days/${dayId}/exports`);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const fileUrl = (f: FileView) => `/api/exports/${f.id}`;
const when = (ms: number | null) => (ms === null ? '' : new Date(ms).toLocaleString());
const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const current = (files: FileView[]) => files.filter((f) => f.supersededBy === null);
const previous = (files: FileView[]) => files.filter((f) => f.supersededBy !== null);
const csvLabel = (f: FileView) => (f.kind === 'penalties_voided_csv' ? 'Voided penalties' : 'Penalties');
const skipText: Record<string, string> = { over_cap: 'over the cap', download_failed: 'download failed', message_deleted: 'message deleted' };

function reasonText(r: Reason): string {
  switch (r.code) {
    case 'no_export':
      return 'No export has succeeded yet.';
    case 'content_intent_missing':
      return 'The export ran without the Message Content intent. Turn it on in the developer portal, then re-export.';
    case 'hash_mismatch':
      return `${r.name} changed on disk since the export. Re-export.`;
    case 'file_missing':
      return `${r.name} is missing from the exports folder. Re-export.`;
    case 'newer_messages':
      return `${r.name} has messages newer than its export. Re-export.`;
    case 'unexported_thread':
      return `The thread ${r.name} was opened after the export. Re-export.`;
    case 'unexported_channel':
      return `${r.name} has no transcript. Re-export.`;
    case 'skipped_attachments':
      return `${r.count} attachment${r.count === 1 ? ' is' : 's are'} skipped. Raise the cap and retry, or discard them.`;
  }
}

async function act(fn: () => Promise<unknown>, done: string) {
  error.value = null;
  notice.value = null;
  try {
    await fn();
    notice.value = done;
    await refresh();
  } catch (err) {
    error.value = errorMessage(err);
  }
}
const reexport = () => act(() => apiFetch(`/api/days/${dayId}/reexport`, { method: 'POST', body: {} }), 'Re-export started.');
const retry = () => act(() => apiFetch(`/api/days/${dayId}/exports/attachments/retry`, { method: 'POST', body: {} }), 'Retrying the skipped attachments.');
const rewrite = () => act(() => apiFetch(`/api/days/${dayId}/exports/csv`, { method: 'POST', body: {} }), 'CSVs written again.');
const confirmingDelete = ref(false);
const deleteNow = () =>
  act(async () => {
    await apiFetch(`/api/days/${dayId}/purge`, { method: 'POST', body: { confirm: true } });
    confirmingDelete.value = false;
  }, 'The purge will run now.');
const discardChosen = ref<number[]>([]);
const discardConfirmed = ref(false);
const discard = () =>
  act(async () => {
    await apiFetch(`/api/days/${dayId}/exports/attachments/discard`, { method: 'POST', body: { attachmentIds: discardChosen.value, confirm: discardConfirmed.value } });
    discardChosen.value = [];
    discardConfirmed.value = false;
  }, 'Discarded.');
</script>

<template>
  <section v-if="data" class="space-y-6">
    <div class="space-y-1">
      <h1 class="text-xl font-semibold">Exports · {{ data.day.title }}</h1>
      <NuxtLink :to="`/days/${dayId}`" class="text-sm underline">Back to the day</NuxtLink>
      <p role="status" class="text-sm" data-testid="exports-state">
        <template v-if="data.day.state === 'closing'">Closing: the export is running.</template>
        <template v-else-if="data.day.state === 'closed'">Closed {{ when(data.day.closedAt) }}. The channels are deleted after {{ when(data.day.graceUntil) }}.</template>
        <template v-else-if="data.day.state === 'purged'">Purged {{ when(data.day.purgedAt) }}: the channels are gone, these files remain.</template>
      </p>
      <p v-if="data.swept.transcriptsAt" class="text-sm">Transcripts and attachments were deleted by retention on {{ when(data.swept.transcriptsAt) }}.</p>
      <p v-if="data.swept.penaltiesAt" class="text-sm">Penalties and CSVs were deleted by retention on {{ when(data.swept.penaltiesAt) }}.</p>
      <UAlert v-if="error" color="error" :title="error" />
      <p v-if="notice" role="status" class="text-sm">{{ notice }}</p>
    </div>

    <section v-if="data.organizer" aria-labelledby="purge-heading" class="space-y-2">
      <h2 id="purge-heading" class="font-semibold">Close-out</h2>
      <p v-if="data.organizer.latestJob" class="text-sm" data-testid="closeout-job">
        Last step: {{ data.organizer.latestJob.kind.replace('_', ' ') }}, {{ data.organizer.latestJob.state }}<template v-if="data.organizer.latestJob.error"> ({{ data.organizer.latestJob.error }})</template>
      </p>
      <UAlert v-if="data.organizer.refusal" color="error" title="The purge was refused: nothing was deleted.">
        <template #description>
          <ul class="list-disc pl-4">
            <li v-for="(r, i) in data.organizer.refusal.reasons" :key="i">{{ reasonText(r) }}</li>
          </ul>
        </template>
      </UAlert>
      <UAlert v-if="data.organizer.contentIntentMissing" color="warning" title="Exported without the Message Content intent: transcripts may be nearly empty." />
      <p v-if="data.organizer.csvBlocked.length" class="text-sm">
        No CSV yet for {{ data.organizer.csvBlocked.map((e) => e.name).join(', ') }}: set the Tournament ID on the
        <NuxtLink :to="`/days/${dayId}`" class="underline">day page</NuxtLink>, which writes the CSVs.
      </p>
      <div v-if="data.organizer.skipped.length" class="space-y-1 text-sm">
        <p>Skipped attachments:</p>
        <label v-for="a in data.organizer.skipped" :key="a.id" class="flex items-center gap-2">
          <input v-model="discardChosen" type="checkbox" :value="a.id" >
          {{ a.filename }} in {{ a.transcriptName }} ({{ skipText[a.reason] ?? a.reason }})
        </label>
        <label class="flex items-center gap-2">
          <input v-model="discardConfirmed" type="checkbox" >
          I understand discarded attachments are lost when the channels are deleted.
        </label>
      </div>
      <div v-if="data.day.state === 'closed' || data.day.state === 'purged'" class="flex flex-wrap gap-2">
        <template v-if="data.day.state === 'closed'">
          <UButton variant="outline" @click="reexport">Re-export</UButton>
          <UButton v-if="data.organizer.skipped.length" variant="outline" @click="retry">Retry attachments</UButton>
          <UButton v-if="data.organizer.skipped.length" color="error" variant="outline" :disabled="!discardChosen.length || !discardConfirmed" @click="discard">
            Discard {{ discardChosen.length }} attachment{{ discardChosen.length === 1 ? '' : 's' }}
          </UButton>
        </template>
        <UButton variant="outline" @click="rewrite">Rewrite CSVs</UButton>
        <UButton v-if="data.day.state === 'closed' && !confirmingDelete" color="error" variant="soft" @click="confirmingDelete = true">Delete now</UButton>
      </div>
      <div v-if="confirmingDelete" role="alertdialog" aria-labelledby="exports-delete-heading" class="border border-error rounded p-3 space-y-2 text-sm">
        <h3 id="exports-delete-heading" class="font-semibold">Delete the channels now?</h3>
        <p>The grace period ends now. Genie deletes the channels only if the export holds everything in them.</p>
        <div class="flex gap-2">
          <UButton color="error" @click="deleteNow">Confirm delete</UButton>
          <UButton variant="ghost" @click="confirmingDelete = false">Cancel</UButton>
        </div>
      </div>
    </section>

    <section aria-labelledby="csv-heading" class="space-y-2">
      <h2 id="csv-heading" class="font-semibold">Penalty CSVs</h2>
      <UAlert color="warning" title="Submit these files as they are." description="Opening one in Excel and saving it again strips leading zeros from player IDs." />
      <p v-if="!data.csvs.length" class="text-sm">No CSVs.</p>
      <div v-for="c in data.csvs" :key="c.eventId" class="text-sm" :data-csv="c.eventName">
        <h3 class="font-medium">{{ c.eventName }}</h3>
        <ul>
          <li v-for="f in current(c.files)" :key="f.id">
            <a :href="fileUrl(f)" class="underline" :download="f.downloadName">{{ csvLabel(f) }}: {{ f.downloadName }}</a> · {{ size(f.bytes) }}
          </li>
        </ul>
        <details v-if="previous(c.files).length">
          <summary>Earlier versions</summary>
          <ul>
            <li v-for="f in previous(c.files)" :key="f.id"><a :href="fileUrl(f)" class="underline">{{ csvLabel(f) }}, {{ when(f.createdAt) }}</a></li>
          </ul>
        </details>
      </div>
    </section>

    <section aria-labelledby="transcripts-heading" class="space-y-2">
      <h2 id="transcripts-heading" class="font-semibold">Transcripts</h2>
      <p v-if="!data.transcripts.length" class="text-sm">No transcripts.</p>
      <div v-for="t in data.transcripts" :key="t.channelId" class="text-sm space-y-1" :data-transcript="t.name">
        <p>
          <strong>#{{ t.name }}</strong>
          · <a :href="fileUrl(t.html)" target="_blank" rel="noopener noreferrer" class="underline">View</a>
          · <a :href="fileUrl(t.json)" class="underline">Download JSON</a>
        </p>
        <ul v-if="t.attachments.length" class="pl-4">
          <li v-for="a in t.attachments" :key="a.id">
            <a v-if="a.fileId" :href="`/api/exports/${a.fileId}`" class="underline">{{ a.filename }}</a><template v-else>{{ a.filename }}</template>
            · {{ a.state }}<template v-if="a.reason"> ({{ skipText[a.reason] ?? a.reason }})</template>
          </li>
        </ul>
        <ul v-if="t.threads.length" class="pl-4">
          <li v-for="th in t.threads" :key="th.threadId ?? th.name" :data-thread="th.name">
            Thread <strong>{{ th.name }}</strong>
            · <a :href="fileUrl(th.html)" target="_blank" rel="noopener noreferrer" class="underline">View</a>
            · <a :href="fileUrl(th.json)" class="underline">Download JSON</a>
            <ul v-if="th.attachments.length" class="pl-4">
              <li v-for="a in th.attachments" :key="a.id">
                <a v-if="a.fileId" :href="`/api/exports/${a.fileId}`" class="underline">{{ a.filename }}</a><template v-else>{{ a.filename }}</template>
                · {{ a.state }}<template v-if="a.reason"> ({{ skipText[a.reason] ?? a.reason }})</template>
              </li>
            </ul>
            <details v-if="th.supersededVersions.length">
              <summary>Earlier versions</summary>
              <ul>
                <li v-for="v in th.supersededVersions" :key="v.json.id"><a :href="fileUrl(v.html)" target="_blank" rel="noopener noreferrer" class="underline">{{ when(v.json.createdAt) }}</a></li>
              </ul>
            </details>
          </li>
        </ul>
        <details v-if="t.supersededVersions.length">
          <summary>Earlier versions</summary>
          <ul>
            <li v-for="v in t.supersededVersions" :key="v.json.id"><a :href="fileUrl(v.html)" target="_blank" rel="noopener noreferrer" class="underline">{{ when(v.json.createdAt) }}</a></li>
          </ul>
        </details>
      </div>
    </section>
  </section>
</template>
