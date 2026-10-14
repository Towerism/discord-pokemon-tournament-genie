<script setup lang="ts">
interface Settings {
  guild: { id: string; name: string };
  organizerRole: { id: string; name: string | null } | null;
  headJudgeRole: { id: string; name: string | null } | null;
  ownerId: string;
  organizerAllowlistEnabled: boolean;
}

const { user } = useUserSession();
const { data: settings } = await useFetch<Settings>('/api/settings');
const isOwner = computed(() => settings.value?.ownerId === user.value?.id);

const allowlist = reactive({ enabled: false, text: '' });
const saved = ref<string | null>(null);
const error = ref<string | null>(null);

onMounted(async () => {
  if (!isOwner.value) return;
  const list = await $fetch<{ enabled: boolean; userIds: string[] }>('/api/settings/organizer-allowlist');
  allowlist.enabled = list.enabled;
  allowlist.text = list.userIds.join('\n');
});

async function saveAllowlist() {
  error.value = null;
  saved.value = null;
  try {
    const userIds = allowlist.text.split(/[\s,]+/).filter(Boolean);
    const result = await $fetch<{ warnings: string[] }>('/api/settings/organizer-allowlist', {
      method: 'PUT',
      body: { enabled: allowlist.enabled, userIds },
    });
    saved.value = result.warnings.includes('empty_allowlist')
      ? 'Saved. The allowlist is on and empty, so only you are an organizer.'
      : 'Saved.';
  } catch (err) {
    error.value = errorMessage(err);
  }
}

const roleName = (r: { id: string; name: string | null } | null) => (r ? (r.name ?? r.id) : 'not mapped');
</script>

<template>
  <section v-if="settings" class="space-y-6">
    <h1 class="text-xl font-semibold">Settings</h1>
    <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      <dt>Server</dt>
      <dd>{{ settings.guild.name }}</dd>
      <dt>Organizer role</dt>
      <dd>{{ roleName(settings.organizerRole) }}</dd>
      <dt>Head judge role</dt>
      <dd>{{ roleName(settings.headJudgeRole) }}</dd>
    </dl>
    <UAlert
      color="warning"
      title="The organizer role is a key to everything"
      description="Anyone in the server with Manage Roles can give someone the organizer role, and with it every day channel and full access to this site. Every login is recorded. The owner can limit organizers with the allowlist below."
    />

    <AttendanceCard />

    <form v-if="isOwner" class="space-y-2" @submit.prevent="saveAllowlist">
      <h2 class="font-semibold">Organizer allowlist</h2>
      <label class="flex items-center gap-2 text-sm">
        <input v-model="allowlist.enabled" type="checkbox" >
        Only listed organizer-role holders are organizers
      </label>
      <label class="block text-sm" for="allowlist-ids">Discord user IDs, one per line</label>
      <textarea id="allowlist-ids" v-model="allowlist.text" rows="5" class="w-full max-w-md border border-accented rounded p-2" />
      <UAlert v-if="allowlist.enabled && !allowlist.text.trim()" color="warning" title="An empty allowlist leaves only you as an organizer." />
      <UAlert v-if="error" color="error" :title="error" />
      <p v-if="saved" role="status" class="text-sm">{{ saved }}</p>
      <UButton type="submit">Save allowlist</UButton>
    </form>
  </section>
</template>
