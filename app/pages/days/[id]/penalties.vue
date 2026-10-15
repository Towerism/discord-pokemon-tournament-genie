<script setup lang="ts">
// An event's penalties for its head judges and organizers (§6.4, ADR-0006): the list with its history, recording one
// when Discord is down, corrections and voids, reposting a lost card, and the CSV the head judge submits (§6.6).
type Severity = 'Minor' | 'Major' | 'Severe';
interface Option {
  id: number;
  label: string;
}
interface PenaltyEvent {
  id: number;
  name: string;
  game: string;
  tournamentId: string | null;
  judges: { staffMemberId: number; name: string; playerId: string }[];
  options: { categories: Option[]; types: Option[] };
}
interface Penalty {
  id: number;
  eventId: number;
  number: number;
  round: number;
  competitorPlayerId: string;
  category: Option;
  severity: Severity;
  penaltyType: Option;
  notes: string;
  judge: { staffMemberId: number; name: string; playerId: string };
  recordedAt: number;
  state: 'active' | 'voided';
  voidReason: string | null;
  revision: number;
  cardState: 'pending' | 'posted' | 'failed' | 'missing' | 'none';
  revisions: { revision: number; action: string; editedByName: string | null; editedAt: number }[];
}
interface Form {
  judgeStaffMemberId: number | null;
  round: number | null;
  competitorPlayerId: string;
  categoryId: number | null;
  severity: Severity;
  penaltyTypeId: number | null;
  notes: string;
}

const route = useRoute();
const dayId = Number(route.params.id);
const { data: plan } = await useFetch<{ day: { title: string; state: string }; can: { closeout: boolean } }>(`/api/days/${dayId}`);
const { data, refresh } = await useFetch<{ events: PenaltyEvent[]; penalties: Penalty[] }>(`/api/days/${dayId}/penalties`);

const eventId = ref<number | null>(data.value?.events[0]?.id ?? null);
const current = computed(() => data.value?.events.find((e) => e.id === eventId.value) ?? null);
const rows = computed(() => (data.value?.penalties ?? []).filter((p) => p.eventId === eventId.value));
const isOpen = computed(() => plan.value?.day.state === 'open');
const isClosed = computed(() => plan.value?.day.state === 'closed' || plan.value?.day.state === 'purged');
/** After close, only organizers correct penalties, and each correction writes the event's CSVs again (§6.4). */
const canChange = computed(() => isOpen.value || (isClosed.value && plan.value?.can.closeout === true));
const error = ref<string | null>(null);

const empty = (): Form => ({ judgeStaffMemberId: null, round: null, competitorPlayerId: '', categoryId: null, severity: 'Minor', penaltyTypeId: null, notes: '' });
const adding = ref<{ key: string; form: Form } | null>(null);
const editing = ref<{ penalty: Penalty; form: Form } | null>(null);
const voiding = ref<{ penalty: Penalty; reason: string } | null>(null);
const expanded = ref<number | null>(null);

async function act(fn: () => Promise<unknown>) {
  error.value = null;
  try {
    await fn();
    await refresh();
    return true;
  } catch (err) {
    error.value = errorMessage(err);
    return false;
  }
}

// The form keeps its key until it records, so a retry after a lost answer returns the same penalty.
function startAdding() {
  adding.value = { key: crypto.randomUUID(), form: empty() };
}
async function record() {
  const { key, form } = adding.value!;
  if (await act(() => apiFetch(`/api/days/${dayId}/penalties`, { method: 'POST', body: { idempotencyKey: key, eventId: eventId.value, ...form } }))) adding.value = null;
}

function startEditing(p: Penalty) {
  editing.value = {
    penalty: p,
    form: { judgeStaffMemberId: p.judge.staffMemberId, round: p.round, competitorPlayerId: p.competitorPlayerId, categoryId: p.category.id, severity: p.severity, penaltyTypeId: p.penaltyType.id, notes: p.notes },
  };
}
async function saveEdit() {
  const { penalty, form } = editing.value!;
  if (await act(() => apiFetch(`/api/days/${dayId}/penalties/${penalty.id}`, { method: 'PATCH', body: { revision: penalty.revision, ...form } }))) editing.value = null;
}

async function voidPenalty() {
  const { penalty, reason } = voiding.value!;
  if (await act(() => apiFetch(`/api/days/${dayId}/penalties/${penalty.id}/void`, { method: 'POST', body: { revision: penalty.revision, reason } }))) voiding.value = null;
}

const repost = (p: Penalty) => act(() => apiFetch(`/api/days/${dayId}/penalties/${p.id}/repost`, { method: 'POST', body: {} }));

/** Fetches the file, so a refusal shows its reason here instead of replacing the page. */
async function download(voided: boolean) {
  error.value = null;
  const res = await fetch(`/api/days/${dayId}/penalties.csv?eventId=${eventId.value}&voided=${voided ? 1 : 0}`);
  if (!res.ok) {
    error.value = ((await res.json().catch(() => null)) as { message?: string } | null)?.message ?? 'The CSV could not be downloaded.';
    return;
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'penalties.csv';
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

/** The options for a select, keeping a choice that is no longer offered when editing. */
const withCurrent = (list: Option[], chosen?: Option) => (chosen && !list.some((o) => o.id === chosen.id) ? [chosen, ...list] : list);
/** The judge of record stays selectable after leaving the event, so a correction doesn't have to change who issued it. */
const withCurrentJudge = (list: PenaltyEvent['judges'], judge: Penalty['judge']) =>
  list.some((j) => j.staffMemberId === judge.staffMemberId) ? list : [judge, ...list];
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
</script>

<template>
  <section v-if="data && plan" class="space-y-6">
    <div class="space-y-1">
      <h1 class="text-xl font-semibold">Penalties · {{ plan.day.title }}</h1>
      <NuxtLink :to="`/days/${dayId}`" class="text-sm underline">Back to the day</NuxtLink>
      <p v-if="isClosed && canChange" role="status" class="text-sm">This day is closed. Corrections write the event's CSVs again; the earlier ones are kept.</p>
      <p v-else-if="isClosed" role="status" class="text-sm">This day is closed.</p>
      <p v-else-if="!isOpen" role="status" class="text-sm">Penalties can be recorded and changed only while the day is open.</p>
    </div>

    <nav v-if="data.events.length > 1" class="flex gap-2" aria-label="Events">
      <UButton v-for="e in data.events" :key="e.id" :variant="e.id === eventId ? 'solid' : 'outline'" @click="eventId = e.id">{{ e.name }}</UButton>
    </nav>

    <template v-if="current">
      <UAlert color="warning" title="Submit this file as it is. Opening and saving it in Excel strips leading zeros from player IDs." />
      <div class="flex gap-2">
        <UButton variant="outline" @click="download(false)">Download CSV</UButton>
        <UButton variant="outline" @click="download(true)">Download voided CSV</UButton>
        <UButton v-if="isOpen && !adding" @click="startAdding">Add penalty</UButton>
      </div>
      <UAlert v-if="error" color="error" :title="error" />

      <form v-if="adding" class="grid max-w-xl grid-cols-[max-content_1fr] gap-2 text-sm" @submit.prevent="record">
        <PenaltyFields v-model="adding.form" :event="current" />
        <div class="col-span-2 flex gap-2">
          <UButton type="submit">Record penalty</UButton>
          <UButton variant="ghost" @click="adding = null">Cancel</UButton>
        </div>
      </form>

      <table class="w-full text-sm">
        <thead>
          <tr class="text-left">
            <th>#</th><th>Round</th><th>Competitor</th><th>Category</th><th>Severity</th><th>Penalty</th><th>Notes</th><th>Judge</th><th>Recorded</th><th>State</th><th>Card</th><th />
          </tr>
        </thead>
        <tbody>
          <template v-for="p in rows" :key="p.id">
            <tr :data-penalty="p.number" :class="{ 'text-muted line-through': p.state === 'voided' }">
              <td>
                <button type="button" class="underline" :aria-expanded="expanded === p.id" @click="expanded = expanded === p.id ? null : p.id">{{ p.number }}</button>
              </td>
              <td>{{ p.round }}</td>
              <td>{{ p.competitorPlayerId }}</td>
              <td>{{ p.category.label }}</td>
              <td>{{ p.severity }}</td>
              <td>{{ p.penaltyType.label }}</td>
              <td class="whitespace-pre-wrap">{{ p.notes }}</td>
              <td>{{ p.judge.name }} ({{ p.judge.playerId }})</td>
              <td>{{ time(p.recordedAt) }}</td>
              <td>{{ p.state }}<template v-if="p.voidReason">: {{ p.voidReason }}</template></td>
              <td>{{ p.cardState }}</td>
              <td class="space-x-1 whitespace-nowrap">
                <template v-if="canChange && p.state === 'active'">
                  <UButton size="xs" variant="outline" @click="startEditing(p)">Edit</UButton>
                  <UButton size="xs" color="error" variant="outline" @click="voiding = { penalty: p, reason: '' }">Void</UButton>
                </template>
                <UButton v-if="isOpen && ['pending', 'failed', 'missing', 'none'].includes(p.cardState)" size="xs" variant="ghost" @click="repost(p)">Repost card</UButton>
              </td>
            </tr>
            <tr v-if="expanded === p.id">
              <td colspan="12">
                <ol class="text-xs">
                  <li v-for="r in p.revisions" :key="r.revision">Revision {{ r.revision }}: {{ r.action }} by {{ r.editedByName ?? 'an organizer' }} at {{ time(r.editedAt) }}</li>
                </ol>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <p v-if="!rows.length" class="text-sm">No penalties yet.</p>

      <form v-if="editing" class="grid max-w-xl grid-cols-[max-content_1fr] gap-2 text-sm" @submit.prevent="saveEdit">
        <h2 class="col-span-2 font-semibold">Edit penalty #{{ editing.penalty.number }}</h2>
        <PenaltyFields
          v-model="editing.form"
          :event="{
            ...current,
            judges: withCurrentJudge(current.judges, editing.penalty.judge),
            options: {
              categories: withCurrent(current.options.categories, editing.penalty.category),
              types: withCurrent(current.options.types, editing.penalty.penaltyType),
            },
          }"
        />
        <div class="col-span-2 flex gap-2">
          <UButton type="submit">Save changes</UButton>
          <UButton variant="ghost" @click="editing = null">Cancel</UButton>
        </div>
      </form>

      <form v-if="voiding" class="max-w-xl space-y-2 text-sm" @submit.prevent="voidPenalty">
        <h2 class="font-semibold">Void penalty #{{ voiding.penalty.number }}</h2>
        <label class="flex flex-col">Reason<textarea v-model="voiding.reason" class="border border-accented rounded p-1" maxlength="500" required /></label>
        <div class="flex gap-2">
          <UButton type="submit" color="error">Void penalty</UButton>
          <UButton variant="ghost" @click="voiding = null">Cancel</UButton>
        </div>
      </form>
    </template>
  </section>
</template>
