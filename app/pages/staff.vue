<script setup lang="ts">
interface StaffMember {
  id: number;
  displayName: string;
  playerId: string | null;
  linkState: 'unlinked' | 'claimed' | 'linked';
  discordUserId: string | null;
  claimedDiscordUserId: string | null;
}
interface Found {
  userId: string;
  displayName: string;
  username: string;
  staffMemberId: number | null;
}

const { data, refresh } = await useFetch<{ staff: StaffMember[] }>('/api/staff', { default: () => ({ staff: [] }) });
const error = ref<string | null>(null);
const note = ref<string | null>(null);

async function act(fn: () => Promise<unknown>, done?: string) {
  error.value = null;
  note.value = null;
  try {
    await fn();
    await refresh();
    if (done) note.value = done;
  } catch (err) {
    error.value = errorMessage(err);
  }
}

// ---- the member picker
const query = ref('');
const found = ref<Found[]>([]);
async function search() {
  error.value = null;
  try {
    found.value = (await apiFetch<{ members: Found[] }>('/api/discord/members', { query: { q: query.value } })).members;
  } catch (err) {
    error.value = errorMessage(err);
  }
}

const form = reactive({ displayName: '', playerId: '', discordUserId: '' });
function pick(m: Found) {
  form.displayName ||= m.displayName;
  form.discordUserId = m.userId;
}
const create = () =>
  act(async () => {
    await apiFetch('/api/staff', {
      method: 'POST',
      body: { displayName: form.displayName, playerId: form.playerId || null, discordUserId: form.discordUserId || null },
    });
    Object.assign(form, { displayName: '', playerId: '', discordUserId: '' });
    found.value = [];
  }, 'Staff member added.');

const linkTo = (s: StaffMember, m: Found) =>
  act(async () => {
    const { syncJobIds } = await apiFetch<{ syncJobIds: number[] }>(`/api/staff/${s.id}`, { method: 'PATCH', body: { discordUserId: m.userId } });
    if (syncJobIds.length) note.value = 'Linked. Open days with this staff member are syncing now.';
  });
const unlink = (s: StaffMember) => act(() => apiFetch(`/api/staff/${s.id}`, { method: 'PATCH', body: { discordUserId: null } }), 'Unlinked. Their old account loses access to open days now.');
const confirm = (s: StaffMember) => act(() => apiFetch(`/api/staff/${s.id}/confirm-claim`, { method: 'POST' }), 'Claim confirmed.');
const reject = (s: StaffMember) => act(() => apiFetch(`/api/staff/${s.id}/reject-claim`, { method: 'POST' }), 'Claim rejected.');
const linkFor = ref<number | null>(null);

// ---- editing a row: one at a time, and only the name and player ID (never the link)
const editing = ref<{ id: number; displayName: string; playerId: string } | null>(null);
function edit(s: StaffMember) {
  editing.value = { id: s.id, displayName: s.displayName, playerId: s.playerId ?? '' };
}
const save = () =>
  act(async () => {
    const { id, displayName, playerId } = editing.value!;
    await apiFetch(`/api/staff/${id}`, { method: 'PATCH', body: { displayName, playerId: playerId || null } });
    // Another row may have been opened while this save was in flight; leave that editor alone.
    if (editing.value?.id === id) editing.value = null;
  }, 'Saved.');
</script>

<template>
  <section class="space-y-6">
    <h1 class="text-xl font-semibold">Staff</h1>
    <UAlert v-if="error" color="error" :title="error" role="alert" />
    <p v-if="note" role="status" class="text-sm">{{ note }}</p>

    <div class="space-y-2">
      <form class="flex items-end gap-2" @submit.prevent="search">
        <label class="text-sm">Find a server member <input v-model="query" required maxlength="32" class="block border border-accented rounded p-1" ></label>
        <UButton type="submit">Search</UButton>
      </form>
      <ul v-if="found.length" class="text-sm space-y-1" aria-label="Server members">
        <li v-for="m in found" :key="m.userId" class="flex items-center gap-2">
          <span>{{ m.displayName }} <span class="text-muted">@{{ m.username }}</span></span>
          <span v-if="m.staffMemberId" class="text-muted">already linked</span>
          <template v-else>
            <UButton size="xs" @click="pick(m)">Use for a new staff member</UButton>
            <UButton v-if="linkFor" size="xs" variant="soft" @click="linkTo(data.staff.find((s) => s.id === linkFor)!, m)">Link to {{ data.staff.find((s) => s.id === linkFor)?.displayName }}</UButton>
          </template>
        </li>
      </ul>
    </div>

    <form class="space-y-2 max-w-md" @submit.prevent="create">
      <h2 class="font-semibold">Add a staff member</h2>
      <label class="block text-sm" for="staff-name">Display name</label>
      <input id="staff-name" v-model="form.displayName" required maxlength="64" class="w-full border border-accented rounded p-1" >
      <label class="block text-sm" for="staff-player">Player ID</label>
      <input id="staff-player" v-model="form.playerId" inputmode="numeric" pattern="\d{1,10}" class="w-full border border-accented rounded p-1" >
      <p class="text-sm">Discord member: {{ form.discordUserId ? found.find((m) => m.userId === form.discordUserId)?.displayName ?? form.discordUserId : 'none (search above)' }}</p>
      <UButton type="submit">Add staff member</UButton>
    </form>

    <!-- Only the table scrolls sideways on a narrow screen; the region lets a keyboard scroll it too. -->
    <div role="region" aria-label="Staff table" tabindex="0" class="overflow-x-auto">
      <table class="data-table">
        <thead>
          <tr><th>Name</th><th>Player ID</th><th>Discord</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="s in data.staff" :key="s.id" :data-staff="s.displayName">
            <td v-if="editing?.id === s.id" colspan="2">
              <form class="flex items-center gap-1" @submit.prevent="save">
                <input v-model="editing.displayName" :aria-label="`Display name for ${s.displayName}`" required maxlength="64" class="border border-accented rounded p-1" >
                <input v-model="editing.playerId" :aria-label="`Player ID for ${s.displayName}`" inputmode="numeric" pattern="\d{1,10}" class="w-28 border border-accented rounded p-1" >
                <UButton type="submit" size="xs">Save</UButton>
                <UButton size="xs" variant="ghost" @click="editing = null">Cancel</UButton>
              </form>
            </td>
            <template v-else>
              <td>{{ s.displayName }}</td>
              <td>{{ s.playerId ?? '—' }}</td>
            </template>
            <td>
              <template v-if="s.linkState === 'linked'">linked ({{ s.discordUserId }})</template>
              <template v-else-if="s.linkState === 'claimed'">claimed by {{ s.claimedDiscordUserId }}</template>
              <template v-else>not linked</template>
            </td>
            <td>
              <div class="flex gap-1">
                <UButton v-if="editing?.id !== s.id" size="xs" variant="ghost" @click="edit(s)">Edit</UButton>
                <template v-if="s.linkState === 'claimed'">
                  <UButton size="xs" @click="confirm(s)">Confirm claim</UButton>
                  <UButton size="xs" variant="soft" @click="reject(s)">Reject</UButton>
                </template>
                <UButton v-if="s.linkState === 'linked'" size="xs" variant="ghost" @click="unlink(s)">Unlink</UButton>
                <UButton v-else size="xs" variant="ghost" @click="linkFor = s.id">Link…</UButton>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
