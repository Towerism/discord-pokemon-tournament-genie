<script setup lang="ts">
interface BotStatus {
  state: 'stopped' | 'connecting' | 'connected' | 'error';
  error?: string;
  latencyMs?: number;
  missingPermissions: string[];
  extraGuilds: { id: string; name: string }[];
  alarms: { kind: 'access_not_revoked'; dayId: number; title: string; since: number }[];
}

const { loggedIn, user, clear } = useUserSession();
const { data: me } = useMe();
const isOrganizer = computed(() => me.value?.isOrganizer === true);
// The bot's state and the alarms are for organizers (FR-40).
const { data: status } = useFetch<BotStatus | null>('/api/status', { immediate: false, watch: [isOrganizer], default: () => null });
watch(isOrganizer, (yes) => {
  if (!yes) status.value = null;
});

const botLine = computed(() => {
  const s = status.value;
  if (!s) return null;
  if (s.state === 'connected') return `Bot connected${s.latencyMs === undefined ? '' : ` (${s.latencyMs} ms)`}`;
  if (s.state === 'connecting') return 'Bot connecting…';
  if (s.state === 'stopped') return 'Bot stopped';
  const why: Record<string, string> = {
    invalid_token: 'Discord refused the bot token.',
    disallowed_intents: 'Turn on the Server Members and Message Content intents in the Discord developer portal.',
    discord_unavailable: 'Discord can’t be reached; retrying.',
    secrets_unreadable: 'The stored bot token can’t be unsealed; check NUXT_VAULT_KEY.',
  };
  return `Bot offline: ${why[s.error ?? ''] ?? 'unknown error'}`;
});

async function logout() {
  await clear();
  await navigateTo('/login');
}
</script>

<template>
  <div class="min-h-screen">
    <header class="border-b border-default px-4 py-3 flex flex-wrap items-center gap-3">
      <NuxtLink to="/" class="font-semibold">Tournament Genie</NuxtLink>
      <template v-if="loggedIn">
        <nav aria-label="Main" class="flex gap-3 text-sm">
          <NuxtLink to="/">Days</NuxtLink>
          <template v-if="isOrganizer">
            <NuxtLink to="/staff">Staff</NuxtLink>
            <NuxtLink to="/blueprints">Blueprints</NuxtLink>
            <NuxtLink to="/settings">Settings</NuxtLink>
          </template>
        </nav>
        <span v-if="botLine" role="status" class="text-sm" :class="status?.state === 'connected' ? 'text-success' : 'text-warning'">
          {{ botLine }}
        </span>
        <span class="ms-auto text-sm">{{ user?.globalName ?? user?.username }}</span>
        <UButton size="sm" variant="ghost" @click="logout">Log out</UButton>
      </template>
    </header>
    <div v-for="alarm in status?.alarms ?? []" :key="alarm.dayId" role="alert" class="px-4 py-2 bg-error/10 text-sm">
      Access not yet revoked on <NuxtLink :to="`/days/${alarm.dayId}`" class="underline">{{ alarm.title }}</NuxtLink>: a sync that removes
      someone's access hasn't succeeded yet.
    </div>
    <div v-if="status && status.missingPermissions.length" role="alert" class="px-4 py-2 bg-warning/10 text-sm">
      The bot is missing permissions: {{ status.missingPermissions.join(', ') }}.
    </div>
    <div v-if="status && status.extraGuilds.length" role="alert" class="px-4 py-2 bg-warning/10 text-sm">
      The bot is also in other servers ({{ status.extraGuilds.map((g) => g.name).join(', ') }}). Genie ignores them; remove it there.
    </div>
    <main class="mx-auto max-w-3xl p-4">
      <slot />
    </main>
  </div>
</template>
