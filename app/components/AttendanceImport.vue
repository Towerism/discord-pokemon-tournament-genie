<script setup lang="ts">
/**
 * Import or refresh a day from attendance (ADR-0008, §4.2): pull, show what would change, accept the checked items.
 * Anything that may take access away on an open day starts unchecked, and so does anything that undoes a hand edit.
 */
type Role = 'headjudge' | 'judge' | 'scorekeeper' | 'administration' | 'translator' | 'streaming';
type Game = 'tcg' | 'vgc' | 'go' | 'other';
interface StaffRef {
  playerId: string;
  name: string;
  role: Role;
  staffMemberId: number | null;
  linkState: string | null;
}
type Change<T> = { from: T; to: T };
type Item =
  | { kind: 'event_added'; key: string; event: { name: string; startsAt: number; game: Game; gameConfirmed: boolean; organizer: { name: string } }; staff: StaffRef[] }
  | { kind: 'event_removed'; key: string; eventId: number; name: string; effect: 'delete' | 'retire'; rolesEnded: { imported: number; byHand: number }; byHandStaff: string[]; uncertain: boolean }
  | {
      kind: 'event_changed';
      key: string;
      eventId: number;
      name: string;
      changes: { name?: Change<string>; startsAt?: Change<number>; tournamentId?: Change<string | null>; game?: Change<Game> };
    }
  | { kind: 'staff_added'; key: string; eventId: number; staff: StaffRef }
  | { kind: 'staff_removed'; key: string; eventId: number; displayName: string; role: Role }
  | { kind: 'role_changed'; key: string; eventId: number; displayName: string; from: Role; to: Role; setByHand: boolean };
interface Pulled {
  snapshotId: string;
  planRevision: number;
  /** The state the diff was made against: the page's own copy of the day may be stale. */
  dayState: 'draft' | 'open';
  fetchedAt: number;
  diff: {
    items: Item[];
    notRefreshed: { eventId: number; name: string; organizer: { name: string | null; playerId: string }; status: string }[];
    unreadProfessors: { playerId: string; name: string; reason: string }[];
    skipped: { tournamentId: string; playerId: string; reason: string }[];
  };
}

const props = defineProps<{
  dayId: number;
  source: 'manual' | 'attendance';
  refreshedAt: number | null;
  eventName: (id: number) => string;
}>();
const emit = defineEmits<{ applied: [] }>();

const connected = ref<boolean | null>(null);
onMounted(async () => {
  connected.value = (await apiFetch<{ configured: boolean }>('/api/settings/attendance')).configured;
});

const isOpen = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const pulled = ref<Pulled | null>(null);
const checked = ref<Record<string, boolean>>({});

const REASONS: Record<string, string> = {
  needs_reconnect: 'needs to reconnect in attendance',
  read_failed: 'couldn’t be read',
  not_connected: 'is no longer connected in attendance',
};
const ROLE_LABEL: Record<Role, string> = { headjudge: 'head judge', judge: 'judge', scorekeeper: 'scorekeeper', administration: 'administration', translator: 'translator', streaming: 'streaming' };
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const gameLabel = (g: Game) => (g === 'other' ? 'other' : g.toUpperCase());

/** Whether an item starts checked: never one that may revoke access on an open day or undo a hand edit. */
function startsChecked(item: Item, dayState: string): boolean {
  const open = dayState === 'open';
  if (item.kind === 'event_removed') return !open && item.rolesEnded.byHand === 0 && !item.uncertain;
  if (item.kind === 'staff_removed') return !open;
  if (item.kind === 'role_changed') return !open && !item.setByHand;
  return true;
}

function describe(item: Item): string {
  switch (item.kind) {
    case 'event_added':
      return `Add ${item.event.name} at ${time(item.event.startsAt)} (${item.event.gameConfirmed ? gameLabel(item.event.game) : 'game not known'}), by ${item.event.organizer.name}${
        item.staff.length ? `, with ${item.staff.map((s) => `${s.name} as ${ROLE_LABEL[s.role]}`).join(', ')}` : ''
      }`;
    case 'event_removed':
      return `${item.effect === 'retire' ? 'Retire' : 'Remove'} ${item.name}${item.effect === 'retire' ? ': its staff lose access, its channels stay' : ''}${
        item.rolesEnded.imported + item.rolesEnded.byHand ? ` (ends ${item.rolesEnded.imported + item.rolesEnded.byHand} staff roles)` : ''
      }`;
    case 'event_changed': {
      const c = item.changes;
      const parts = [
        c.name && `name ${c.name.from} → ${c.name.to}`,
        c.startsAt && `start ${time(c.startsAt.from)} → ${time(c.startsAt.to)}`,
        c.tournamentId && `tournament ID ${c.tournamentId.from ?? 'none'} → ${c.tournamentId.to}`,
        c.game && `game ${gameLabel(c.game.from)} → ${gameLabel(c.game.to)}`,
      ].filter(Boolean);
      return `Change ${item.name}: ${parts.join(', ')}`;
    }
    case 'staff_added':
      return `Add ${item.staff.name} as ${ROLE_LABEL[item.staff.role]} on ${props.eventName(item.eventId)}${item.staff.staffMemberId === null ? ' (new to the Staff page, not linked)' : item.staff.linkState !== 'linked' ? ' (not linked)' : ''}`;
    case 'staff_removed':
      return `Remove ${item.displayName} (${ROLE_LABEL[item.role]}) from ${props.eventName(item.eventId)}`;
    case 'role_changed':
      return `${item.displayName} on ${props.eventName(item.eventId)}: ${ROLE_LABEL[item.from]} → ${ROLE_LABEL[item.to]}`;
  }
}

function warnings(item: Item): string[] {
  const out: string[] = [];
  const open = pulled.value?.dayState === 'open';
  if (open && (item.kind === 'event_removed' || item.kind === 'staff_removed' || item.kind === 'role_changed')) out.push('Accepting may revoke access at once.');
  if (item.kind === 'event_removed' && item.byHandStaff.length) out.push(`Also ends roles you added by hand: ${item.byHandStaff.join(', ')}.`);
  if (item.kind === 'event_removed' && item.uncertain) out.push('A professor couldn’t be read: this tournament may have moved to them.');
  if (item.kind === 'role_changed' && item.setByHand) out.push('You set this role by hand.');
  if (item.kind === 'role_changed' && item.from === 'streaming') out.push('Accepting makes them a judge: they get the event’s floor and penalties channels.');
  return out;
}

const groups = computed(() => {
  const items = pulled.value?.diff.items ?? [];
  return [
    { title: 'Added', items: items.filter((i) => i.kind === 'event_added' || i.kind === 'staff_added') },
    { title: 'Removed', items: items.filter((i) => i.kind === 'event_removed' || i.kind === 'staff_removed') },
    { title: 'Changed', items: items.filter((i) => i.kind === 'event_changed' || i.kind === 'role_changed') },
  ].filter((g) => g.items.length);
});

function explain(err: unknown): string {
  const data = (err as { data?: { data?: Record<string, unknown> } })?.data?.data ?? {};
  switch (errorCode(err)) {
    case 'timezone_mismatch':
      return `Attendance uses ${String(data.attendanceTimeZone)} and Genie uses ${String(data.genieTimeZone)}. Set the same time zone on both.`;
    case 'attendance_rate_limited':
      return `Attendance asked to wait. Try again in ${String(data.retryAfterSeconds)} s.`;
    case 'plan_changed':
    case 'snapshot_stale':
      return 'Someone changed the plan: refresh again.';
    case 'no_connected_organizers':
      return 'No professor is connected to attendance.';
    case 'attendance_token_rejected':
      return 'Attendance refused the token. Mint a new one and save it in Settings.';
    case 'attendance_unavailable':
      return 'Attendance can’t be reached right now. Try again, or add events by hand.';
    case 'import_in_progress':
      return 'This day is already being imported.';
    default:
      return errorMessage(err);
  }
}

async function pull() {
  error.value = null;
  busy.value = true;
  try {
    pulled.value = await apiFetch<Pulled>(`/api/days/${props.dayId}/import`, { method: 'POST' });
    checked.value = Object.fromEntries(pulled.value.diff.items.map((i) => [i.key, startsChecked(i, pulled.value!.dayState)]));
    isOpen.value = true;
  } catch (err) {
    error.value = explain(err);
  } finally {
    busy.value = false;
  }
}

async function accept() {
  if (!pulled.value) return;
  error.value = null;
  busy.value = true;
  try {
    await apiFetch(`/api/days/${props.dayId}/import/accept`, {
      method: 'POST',
      body: {
        snapshotId: pulled.value.snapshotId,
        planRevision: pulled.value.planRevision,
        keys: Object.entries(checked.value)
          .filter(([, on]) => on)
          .map(([key]) => key),
      },
    });
    isOpen.value = false;
    pulled.value = null;
    emit('applied');
  } catch (err) {
    error.value = explain(err);
  } finally {
    busy.value = false;
  }
}

const ago = computed(() => {
  if (props.refreshedAt === null) return null;
  const minutes = Math.max(0, Math.round((Date.now() - props.refreshedAt) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
});
</script>

<template>
  <div class="space-y-1">
    <div class="flex flex-wrap items-center gap-2">
      <UButton :disabled="connected !== true || busy" :loading="busy && !isOpen" @click="pull">
        {{ source === 'attendance' ? 'Refresh from attendance' : 'Import from attendance' }}
      </UButton>
      <NuxtLink v-if="connected === false" to="/settings" class="text-sm underline">Connect attendance in Settings</NuxtLink>
      <span v-if="ago" class="text-sm text-muted">Refreshed from attendance {{ ago }}</span>
    </div>
    <UAlert v-if="error && !isOpen" color="error" :title="error" />

    <UModal v-model:open="isOpen" title="Import from attendance" :ui="{ content: 'max-w-3xl' }">
      <template #body>
        <div v-if="pulled" class="space-y-4 text-sm">
          <UAlert
            v-for="p in pulled.diff.unreadProfessors"
            :key="p.playerId"
            color="warning"
            :title="`${p.name} ${REASONS[p.reason] ?? p.reason}: their tournaments weren't refreshed.`"
          />
          <ul v-if="pulled.diff.notRefreshed.length" class="text-muted">
            <li v-for="n in pulled.diff.notRefreshed" :key="n.eventId">
              {{ n.name }}: not refreshed: {{ n.organizer.name ?? n.organizer.playerId }} {{ REASONS[n.status] ?? n.status }}
            </li>
          </ul>
          <p v-if="!pulled.diff.items.length">Nothing to change: the plan matches attendance.</p>
          <fieldset v-for="g in groups" :key="g.title" class="space-y-1">
            <legend class="font-semibold">{{ g.title }}</legend>
            <label v-for="item in g.items" :key="item.key" class="flex items-start gap-2" :data-item="item.kind">
              <input v-model="checked[item.key]" type="checkbox" class="mt-1" >
              <span>
                {{ describe(item) }}
                <span v-for="w in warnings(item)" :key="w" class="block text-warning">{{ w }}</span>
              </span>
            </label>
          </fieldset>
          <div v-if="pulled.diff.skipped.length">
            <p class="font-semibold">Skipped</p>
            <ul class="text-muted">
              <li v-for="s in pulled.diff.skipped" :key="`${s.tournamentId}:${s.playerId}:${s.reason}`">
                Player {{ s.playerId }}: {{ s.reason === 'invalid_player_id' ? 'not a player ID' : 'listed twice in one tournament' }}
              </li>
            </ul>
          </div>
          <UAlert v-if="error" color="error" :title="error" />
        </div>
      </template>
      <template #footer>
        <div class="flex gap-2">
          <UButton :loading="busy" @click="accept">Accept selected</UButton>
          <UButton color="neutral" variant="ghost" @click="isOpen = false">Cancel</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
