<script setup lang="ts">
type Role = 'headjudge' | 'judge' | 'scorekeeper' | 'administration' | 'translator' | 'streaming';
interface EventView {
  id: number;
  name: string;
  slug: string;
  game: 'tcg' | 'vgc' | 'go' | 'other';
  gameConfirmed: boolean;
  startTime: string;
  tournamentId: string | null;
  attendance: { tournamentId: string; organizerPlayerId: string | null; organizerName: string | null } | null;
}
interface JobView {
  id: number;
  kind: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  error: string | null;
}
interface JobEvent {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}
interface DayPlan {
  day: {
    id: number;
    date: string;
    title: string;
    state: string;
    blueprintId: number;
    categoryId: string | null;
    attendance: { source: 'manual' | 'attendance'; refreshedAt: number | null };
    closingAt: number | null;
    closedAt: number | null;
    graceUntil: number | null;
    purgedAt: number | null;
  };
  events: EventView[];
  staff: { staffMemberId: number; displayName: string; linkState: string; events: { eventId: number; role: Role }[] }[];
  sync: { inSync: boolean; revocationPending: boolean };
  latestJob: JobView | null;
  channels: { key: string; eventId: number | null; discordChannelId: string; state: string }[];
  orphans: { discordChannelId: string; kind: string; name: string }[];
  can: { edit: boolean; open: boolean; sync: boolean; penalties: boolean; close: boolean; closeout: boolean; exports: boolean };
}
interface ClosePreflight {
  recentPenalties: { penaltyId: number; eventId: number; number: number; recordedAt: number }[];
  csvBlocked: { eventId: number; name: string }[];
  channels: number;
}
interface Preview {
  category: { name: string };
  channels: { key: string; eventId: number | null; name: string; audience: { staffMemberId: number; displayName: string }[] }[];
  problems: { code: string }[];
  headJudgeRole: 'checked' | 'unavailable';
}

const ROLES: { value: Role; label: string }[] = [
  { value: 'headjudge', label: 'Head judge' },
  { value: 'judge', label: 'Judge' },
  { value: 'scorekeeper', label: 'Scorekeeper' },
  { value: 'administration', label: 'Administration' },
  { value: 'translator', label: 'Translator' },
  // Not a judge, and sees only streaming channels (ADR-0015).
  { value: 'streaming', label: 'Streaming' },
];

const route = useRoute();
const dayId = Number(route.params.id);
const { data: plan, refresh: refreshPlan } = await useFetch<DayPlan>(`/api/days/${dayId}`);
const { data: preview, refresh: refreshPreview } = await useFetch<Preview>(`/api/days/${dayId}/preview`);
const { data: directory } = await useFetch<{ staff: { id: number; displayName: string; linkState: string }[] }>('/api/staff', {
  immediate: plan.value?.can.edit === true,
  default: () => ({ staff: [] }),
});
const error = ref<string | null>(null);

async function act(fn: () => Promise<unknown>) {
  error.value = null;
  try {
    await fn();
    await Promise.all([refreshPlan(), refreshPreview()]);
  } catch (err) {
    error.value = errorMessage(err);
  }
}

// ---- job progress: the job's events, live, over SSE.
const jobEvents = ref<JobEvent[]>([]);
let source: EventSource | null = null;
function follow(jobId: number) {
  source?.close();
  jobEvents.value = [];
  source = new EventSource(`/api/jobs/${jobId}/events`);
  source.onmessage = (e) => jobEvents.value.push(JSON.parse(e.data) as JobEvent);
  source.onerror = () => {
    source?.close();
    source = null;
    void refreshPlan();
  };
}
onMounted(() => {
  const job = plan.value?.latestJob;
  if (job) follow(job.id);
});
onBeforeUnmount(() => source?.close());

const open = () =>
  act(async () => {
    const { jobId } = await apiFetch<{ jobId: number }>(`/api/days/${dayId}/open`, { method: 'POST' });
    follow(jobId);
  });
const sync = () =>
  act(async () => {
    const { jobId } = await apiFetch<{ jobId: number }>(`/api/days/${dayId}/sync`, { method: 'POST' });
    follow(jobId);
  });

// ---- close-out (§6.5): close with a confirmation, then Delete now once the day is closed.
const preflight = ref<ClosePreflight | null>(null);
const askClose = () =>
  act(async () => {
    preflight.value = await apiFetch<ClosePreflight>(`/api/days/${dayId}/close`);
  });
const close = () =>
  act(async () => {
    const { jobId } = await apiFetch<{ jobId: number }>(`/api/days/${dayId}/close`, { method: 'POST', body: { confirm: true } });
    preflight.value = null;
    follow(jobId);
  });
const confirmingDelete = ref(false);
const deleteNow = () =>
  act(async () => {
    const { jobId } = await apiFetch<{ jobId: number }>(`/api/days/${dayId}/purge`, { method: 'POST', body: { confirm: true } });
    confirmingDelete.value = false;
    follow(jobId);
  });
const when = (ms: number | null) => (ms === null ? '' : new Date(ms).toLocaleString());
/** After close the Tournament ID is the one change an organizer can make; it writes the event's CSVs (§6.6). */
const closedDay = computed(() => plan.value?.day.state === 'closed' || plan.value?.day.state === 'purged');
const tournamentIds = reactive<Record<number, string>>({});
const setTournamentId = (eventId: number) =>
  act(() => apiFetch(`/api/days/${dayId}/events/${eventId}`, { method: 'PATCH', body: { tournamentId: tournamentIds[eventId]?.trim() || null } }));
/** The plan freezes once the day is closing: nothing may change who can see its locked channels. */
const editable = computed(() => plan.value?.can.edit === true && (plan.value.day.state === 'draft' || plan.value.day.state === 'open'));

// ---- events
const newEvent = reactive({ name: '', game: 'tcg', startTime: '10:00', tournamentId: '' });
const addEvent = () =>
  act(async () => {
    await apiFetch(`/api/days/${dayId}/events`, {
      method: 'POST',
      body: { name: newEvent.name, game: newEvent.game, startTime: newEvent.startTime, ...(newEvent.tournamentId ? { tournamentId: newEvent.tournamentId } : {}) },
    });
    newEvent.name = '';
    newEvent.tournamentId = '';
  });
const removeEvent = (eventId: number) => act(() => apiFetch(`/api/days/${dayId}/events/${eventId}`, { method: 'DELETE' }));
/** Setting the game confirms it: an imported tournament whose game attendance didn't know. */
const setGame = (eventId: number, game: string) => act(() => apiFetch(`/api/days/${dayId}/events/${eventId}`, { method: 'PATCH', body: { game } }));
const importable = editable;
const imported = () => Promise.all([refreshPlan(), refreshPreview()]);

// ---- staff and roles: edited locally, saved whole (PUT replaces).
const roster = ref<{ staffMemberId: number; displayName: string; roles: Record<number, Role | ''> }[]>([]);
watchEffect(() => {
  roster.value = (plan.value?.staff ?? []).map((s) => ({
    staffMemberId: s.staffMemberId,
    displayName: s.displayName,
    roles: Object.fromEntries(s.events.map((e) => [e.eventId, e.role])),
  }));
});
const toAdd = ref('');
const addable = computed(() => directory.value.staff.filter((s) => !roster.value.some((r) => r.staffMemberId === s.id)));
function addStaffer() {
  const s = directory.value.staff.find((x) => x.id === Number(toAdd.value));
  if (s) roster.value.push({ staffMemberId: s.id, displayName: s.displayName, roles: {} });
  toAdd.value = '';
}
const removeStaffer = (id: number) => (roster.value = roster.value.filter((r) => r.staffMemberId !== id));
const saveStaff = () =>
  act(() =>
    apiFetch(`/api/days/${dayId}/staff`, {
      method: 'PUT',
      body: {
        staff: roster.value.map((r) => ({
          staffMemberId: r.staffMemberId,
          events: Object.entries(r.roles)
            .filter(([, role]) => role)
            .map(([eventId, role]) => ({ eventId: Number(eventId), role })),
        })),
      },
    }),
  );
const linkLabel = (state: string) => ({ linked: 'linked', claimed: 'claim not confirmed', unlinked: 'not linked' })[state] ?? state;

// ---- orphans
const adoptTarget = reactive<Record<string, string>>({});
const keys = computed(() => (preview.value?.channels ?? []).map((c) => ({ value: `${c.key}|${c.eventId ?? ''}`, label: c.name })));
const adopt = (channelId: string) =>
  act(() => {
    const [key, eventId] = (adoptTarget[channelId] ?? '').split('|');
    return apiFetch(`/api/days/${dayId}/orphans/${channelId}/adopt`, { method: 'POST', body: { key, eventId: eventId ? Number(eventId) : null } });
  });
const removeOrphan = (channelId: string) => act(() => apiFetch(`/api/days/${dayId}/orphans/${channelId}/delete`, { method: 'POST' }));
const eventName = (id: number | null) => plan.value?.events.find((e) => e.id === id)?.name ?? '';
</script>

<template>
  <section v-if="plan" class="space-y-8">
    <div class="space-y-1">
      <h1 class="text-xl font-semibold">{{ plan.day.title }}</h1>
      <p class="text-sm text-muted">{{ plan.day.date }} · {{ plan.day.state }}</p>
      <UAlert v-if="plan.sync.revocationPending" color="error" title="Access not yet revoked: a sync that removes someone's access hasn't succeeded." />
      <p v-else-if="plan.day.state === 'open'" role="status" class="text-sm">{{ plan.sync.inSync ? 'Discord matches the plan.' : 'Discord is out of sync with the plan: Sync applies it.' }}</p>
      <p v-if="plan.day.state === 'closing'" role="status" class="text-sm">Closing: the channels are being locked and exported.</p>
      <p v-else-if="plan.day.state === 'closed'" role="status" class="text-sm">Closed. The channels stay locked until {{ when(plan.day.graceUntil) }}, then they are deleted.</p>
      <p v-else-if="plan.day.state === 'purged'" role="status" class="text-sm">Closed and purged on {{ when(plan.day.purgedAt) }}: the channels are gone; the exports remain.</p>
      <div class="flex gap-2 pt-2">
        <UButton v-if="plan.can.open && plan.day.state === 'draft'" @click="open">Open the day</UButton>
        <UButton v-if="plan.can.sync && plan.day.state === 'open'" @click="sync">Sync</UButton>
        <UButton v-if="plan.can.close && plan.day.state === 'open'" color="error" variant="soft" @click="askClose">Close the day</UButton>
        <UButton v-if="plan.can.penalties && plan.day.state !== 'draft'" :to="`/days/${dayId}/penalties`" variant="outline">Penalties</UButton>
        <UButton v-if="plan.can.exports" :to="`/days/${dayId}/exports`" variant="outline">Exports</UButton>
        <UButton v-if="plan.can.closeout && plan.day.state === 'closed' && !confirmingDelete" color="error" variant="ghost" @click="confirmingDelete = true">Delete now</UButton>
      </div>
      <div v-if="preflight" role="alertdialog" aria-labelledby="close-heading" class="border border-error rounded p-3 space-y-2 text-sm">
        <h2 id="close-heading" class="font-semibold">Close {{ plan.day.title }}?</h2>
        <p>Its {{ preflight.channels }} channels will be locked, so nobody but Genie can post, then exported. This can't be undone.</p>
        <p v-if="preflight.recentPenalties.length" data-testid="recent-penalties">
          Still in their judge's 15 minutes to edit:
          {{ preflight.recentPenalties.map((p) => `#${p.number} (${eventName(p.eventId)})`).join(', ') }}.
        </p>
        <p v-if="preflight.csvBlocked.length">No Tournament ID, so no CSV until one is set: {{ preflight.csvBlocked.map((e) => e.name).join(', ') }}.</p>
        <div class="flex gap-2">
          <UButton color="error" @click="close">Confirm close</UButton>
          <UButton variant="ghost" @click="preflight = null">Cancel</UButton>
        </div>
      </div>
      <div v-if="confirmingDelete" role="alertdialog" aria-labelledby="delete-heading" class="border border-error rounded p-3 space-y-2 text-sm">
        <h2 id="delete-heading" class="font-semibold">Delete the channels now?</h2>
        <p>The grace period ends now. Genie deletes the channels only if the export holds everything in them.</p>
        <div class="flex gap-2">
          <UButton color="error" @click="deleteNow">Confirm delete</UButton>
          <UButton variant="ghost" @click="confirmingDelete = false">Cancel</UButton>
        </div>
      </div>
      <UAlert v-if="error" color="error" :title="error" />
    </div>

    <section v-if="plan.latestJob" aria-labelledby="job-heading" class="space-y-1">
      <h2 id="job-heading" class="font-semibold">Last job</h2>
      <p role="status" data-testid="job-state">{{ plan.latestJob.kind }}: {{ plan.latestJob.state }}<template v-if="plan.latestJob.error"> ({{ plan.latestJob.error }})</template></p>
      <ol class="text-sm space-y-0.5">
        <li v-for="e in jobEvents" :key="e.id" :class="{ 'text-warning': e.level === 'warn', 'text-error': e.level === 'error' }">{{ e.message }}</li>
      </ol>
    </section>

    <section aria-labelledby="events-heading" class="space-y-2">
      <h2 id="events-heading" class="font-semibold">Events</h2>
      <AttendanceImport
        v-if="importable"
        :day-id="dayId"
        :source="plan.day.attendance.source"
        :refreshed-at="plan.day.attendance.refreshedAt"
        :event-name="(id: number) => eventName(id)"
        @applied="imported"
      />
      <!-- Only the table scrolls sideways on a narrow screen; the region lets a keyboard scroll it too. -->
      <div role="region" aria-label="Events table" tabindex="0" class="overflow-x-auto">
        <table class="data-table">
          <thead>
            <tr><th>Event</th><th>Channels</th><th>Game</th><th>Starts</th><th>Tournament ID</th><th>Organizer</th><th /></tr>
          </thead>
          <tbody>
            <tr v-for="e in plan.events" :key="e.id">
              <td>{{ e.name }}</td>
              <td>{{ e.slug }}</td>
              <td>
                <template v-if="e.gameConfirmed">{{ e.game.toUpperCase() }}</template>
                <span v-else class="flex items-center gap-1">
                  <UBadge color="warning" variant="soft">game not confirmed</UBadge>
                  <select
                    v-if="editable"
                    :aria-label="`Game of ${e.name}`"
                    class="border border-accented rounded p-1"
                    @change="setGame(e.id, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">Set the game…</option>
                    <option value="tcg">TCG</option><option value="vgc">VGC</option><option value="go">GO</option><option value="other">Other</option>
                  </select>
                </span>
              </td>
              <td>{{ e.startTime }}</td>
              <td>
                <form v-if="plan.can.closeout && closedDay" class="flex items-center gap-1" @submit.prevent="setTournamentId(e.id)">
                  <input
                    v-model="tournamentIds[e.id]"
                    :placeholder="e.tournamentId ?? '25-12-001050'"
                    :aria-label="`Tournament ID of ${e.name}`"
                    class="w-32 border border-accented rounded p-1"
                  >
                  <UButton type="submit" size="xs" variant="outline">Set</UButton>
                </form>
                <template v-else>{{ e.tournamentId ?? '—' }}</template>
              </td>
              <td>{{ e.attendance?.organizerName ?? (e.attendance ? e.attendance.organizerPlayerId : '—') }}</td>
              <td><UButton v-if="editable && plan.day.state === 'draft'" size="xs" variant="ghost" @click="removeEvent(e.id)">Remove</UButton></td>
            </tr>
          </tbody>
        </table>
      </div>
      <form v-if="editable" class="flex flex-wrap items-end gap-2" @submit.prevent="addEvent">
        <label class="text-sm">Event name <input v-model="newEvent.name" required maxlength="64" class="block border border-accented rounded p-1" ></label>
        <label class="text-sm">Game
          <select v-model="newEvent.game" class="block border border-accented rounded p-1">
            <option value="tcg">TCG</option><option value="vgc">VGC</option><option value="go">GO</option><option value="other">Other</option>
          </select>
        </label>
        <label class="text-sm">Start time <input v-model="newEvent.startTime" type="time" required class="block border border-accented rounded p-1" ></label>
        <label class="text-sm">Tournament ID <input v-model="newEvent.tournamentId" placeholder="25-12-001050" class="block border border-accented rounded p-1" ></label>
        <UButton type="submit">Add event</UButton>
      </form>
    </section>

    <section aria-labelledby="staff-heading" class="space-y-2">
      <h2 id="staff-heading" class="font-semibold">Staff</h2>
      <div role="region" aria-label="Staff table" tabindex="0" class="overflow-x-auto">
        <table class="data-table">
          <thead>
            <tr><th>Staff</th><th v-for="e in plan.events" :key="e.id">{{ e.name }}</th><th /></tr>
          </thead>
          <tbody>
            <tr v-for="r in roster" :key="r.staffMemberId">
              <td>
                {{ r.displayName }}
                <span v-if="plan.staff.find((s) => s.staffMemberId === r.staffMemberId)?.linkState !== 'linked'" class="text-warning">
                  ({{ linkLabel(plan.staff.find((s) => s.staffMemberId === r.staffMemberId)?.linkState ?? 'unlinked') }})
                </span>
              </td>
              <td v-for="e in plan.events" :key="e.id">
                <select v-model="r.roles[e.id]" :disabled="!editable" :aria-label="`${r.displayName}'s role in ${e.name}`" class="border border-accented rounded p-1">
                  <option value="">—</option>
                  <option v-for="role in ROLES" :key="role.value" :value="role.value">{{ role.label }}</option>
                </select>
              </td>
              <td><UButton v-if="editable" size="xs" variant="ghost" @click="removeStaffer(r.staffMemberId)">Remove</UButton></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="editable" class="flex flex-wrap items-end gap-2">
        <label class="text-sm">Add staff
          <select v-model="toAdd" class="block border border-accented rounded p-1" @change="addStaffer">
            <option value="">Choose…</option>
            <option v-for="s in addable" :key="s.id" :value="s.id">{{ s.displayName }}</option>
          </select>
        </label>
        <UButton @click="saveStaff">Save staff</UButton>
      </div>
    </section>

    <section v-if="preview" aria-labelledby="preview-heading" class="space-y-2">
      <h2 id="preview-heading" class="font-semibold">Channels and who can see them</h2>
      <p class="text-sm">Category <strong>{{ preview.category.name }}</strong>. The organizer role and the bot can also see every channel.</p>
      <UAlert v-if="preview.headJudgeRole === 'unavailable'" color="warning" title="Discord couldn't be reached: head judges by Discord role aren't shown." />
      <ul class="text-sm space-y-1">
        <li v-for="c in preview.channels" :key="`${c.key}:${c.eventId}`" :data-channel="c.name">
          <strong>#{{ c.name }}</strong>: {{ c.audience.map((a) => a.displayName).join(', ') || 'nobody yet' }}
        </li>
      </ul>
      <ul v-if="preview.problems.length" class="text-sm text-warning">
        <li v-for="p in preview.problems" :key="p.code">{{ p.code.replaceAll('_', ' ') }}</li>
      </ul>
    </section>

    <section v-if="plan.channels.length || plan.orphans.length" aria-labelledby="discord-heading" class="space-y-2">
      <h2 id="discord-heading" class="font-semibold">In Discord</h2>
      <ul class="text-sm">
        <li v-for="c in plan.channels.filter((x) => x.state === 'present')" :key="c.discordChannelId" data-testid="provisioned-channel">
          {{ c.key }}<template v-if="c.eventId"> ({{ eventName(c.eventId) }})</template>: {{ c.discordChannelId }}
        </li>
      </ul>
      <div v-for="o in plan.orphans" :key="o.discordChannelId" class="flex flex-wrap items-center gap-2 text-sm">
        <span>Found {{ o.kind }} <strong>{{ o.name }}</strong>, which Genie didn't create.</span>
        <template v-if="editable">
          <label v-if="o.kind === 'channel'">Adopt as
            <select v-model="adoptTarget[o.discordChannelId]" class="border border-accented rounded p-1">
              <option v-for="k in keys" :key="k.value" :value="k.value">#{{ k.label }}</option>
            </select>
          </label>
          <UButton v-if="o.kind === 'channel'" size="xs" @click="adopt(o.discordChannelId)">Adopt</UButton>
          <UButton size="xs" color="error" variant="soft" @click="removeOrphan(o.discordChannelId)">Delete</UButton>
        </template>
      </div>
    </section>
  </section>
</template>
