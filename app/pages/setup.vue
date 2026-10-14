<script setup lang="ts">
interface Check {
  id: string;
  ok: boolean;
  detail?: string | string[];
}
interface Checks {
  checks: Check[];
  warnings: ({ id: 'bot_has_administrator' } | { id: 'bot_in_other_guilds'; guilds: { id: string; name: string }[] })[];
}
interface Progress {
  unlocked: boolean;
  clientId: string | null;
  guild: { id: string; name: string } | null;
  organizerRoleId: string | null;
  headJudgeRoleId: string | null;
  ownerId: string | null;
  inviteUrl: string | null;
  lastChecks: Checks | null;
}

const route = useRoute();
const { complete } = useSetupComplete();
const { data: progress, refresh } = await useFetch<Progress>('/api/setup');
const checks = ref<Checks | null>(progress.value?.lastChecks ?? null);
const error = ref<string | null>(null);
const busy = ref(false);

const code = ref('');
const app = reactive({ botToken: '', clientId: '', clientSecret: '' });
const guilds = ref<{ id: string; name: string }[]>([]);
const guildId = ref('');
const roles = ref<{ id: string; name: string }[]>([]);
const roleMap = reactive({ organizerRoleId: '', headJudgeRoleId: '' });

const loginErrors: Record<string, string> = {
  choose_guild_first: 'Choose the server before logging in.',
  owner_not_in_guild: 'That Discord account isn’t a member of the chosen server.',
  discord_unavailable: 'Discord couldn’t be reached. Try again.',
};
const loginError = computed(() => loginErrors[String(route.query.error ?? '')] ?? null);

const labels: Record<string, [string, string]> = {
  token_valid: ['The bot token is valid', 'Paste the token from the Bot page of your Discord application.'],
  client_id_matches: ['The client ID belongs to the bot', 'Copy the client ID from the OAuth2 page of the same application.'],
  public_bot_off: ['Public Bot is off', 'Turn off Public Bot on the Bot page, so nobody else can invite it.'],
  intent_guild_members: ['The Server Members intent is on', 'Turn it on under Privileged Gateway Intents on the Bot page.'],
  intent_message_content: ['The Message Content intent is on', 'Turn it on under Privileged Gateway Intents on the Bot page.'],
  bot_in_guild: ['The bot is in the server', 'Invite the bot with the link above.'],
  permissions_present: ['The bot has every permission it needs', 'Invite the bot again with the link above.'],
  owner_bound: ['You logged in as the owner', 'Log in with Discord below.'],
  owner_in_guild: ['The owner is a member of the server', 'Log in with an account that is a member of the server.'],
  roles_mapped: ['The organizer and head-judge roles are mapped', 'Pick both roles below.'],
  bot_role_above_mapped_roles: ['The bot’s role is above both mapped roles', 'In Server Settings → Roles, drag the bot’s role above them.'],
};
const describe = (c: Check) => {
  const [label, fix] = labels[c.id] ?? [c.id, ''];
  if (c.ok) return label;
  if (c.detail === 'not_yet') return `${label}: not yet`;
  if (c.detail === 'discord_unavailable') return `${label}: Discord couldn’t be reached`;
  const detail = Array.isArray(c.detail) ? ` (${c.detail.join(', ')})` : '';
  return `${label}${detail}. ${fix}`;
};

async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
  busy.value = true;
  error.value = null;
  try {
    return await fn();
  } catch (err) {
    error.value = errorMessage(err);
    const data = (err as { data?: { data?: { checks?: Check[]; warnings?: Checks['warnings'] } } }).data?.data;
    if (data?.checks) checks.value = { checks: data.checks, warnings: data.warnings ?? [] };
    return undefined;
  } finally {
    busy.value = false;
  }
}

const unlock = () =>
  run(async () => {
    await $fetch('/api/setup/unlock', { method: 'POST', body: { code: code.value } });
    await refresh();
  });

const saveApp = () =>
  run(async () => {
    checks.value = await $fetch<Checks>('/api/setup/discord', { method: 'POST', body: app });
    await refresh();
  });

const loadGuilds = () =>
  run(async () => {
    guilds.value = (await $fetch<{ guilds: { id: string; name: string }[] }>('/api/setup/guilds')).guilds;
    guildId.value = progress.value?.guild?.id ?? guilds.value[0]?.id ?? '';
  });

const chooseGuild = () =>
  run(async () => {
    checks.value = await $fetch<Checks>('/api/setup/guild', { method: 'POST', body: { guildId: guildId.value } });
    await refresh();
  });

async function loadRoles() {
  if (!progress.value?.guild || !progress.value.ownerId) return;
  await run(async () => {
    roles.value = (await $fetch<{ roles: { id: string; name: string }[] }>('/api/setup/roles')).roles;
    roleMap.organizerRoleId = progress.value?.organizerRoleId ?? '';
    roleMap.headJudgeRoleId = progress.value?.headJudgeRoleId ?? '';
  });
}

const saveRoles = () =>
  run(async () => {
    checks.value = await $fetch<Checks>('/api/setup/roles', { method: 'POST', body: roleMap });
    await refresh();
  });

const recheck = () =>
  run(async () => {
    checks.value = await $fetch<Checks>('/api/setup/check', { method: 'POST' });
  });

const finish = () =>
  run(async () => {
    await $fetch('/api/setup/finish', { method: 'POST' });
    complete.value = true;
    await useUserSession().fetch();
    await navigateTo('/');
  });

onMounted(loadRoles);
</script>

<template>
  <section class="space-y-6">
    <h1 class="text-xl font-semibold">Set up Tournament Genie</h1>
    <UAlert v-if="error" color="error" :title="error" role="alert" />

    <form v-if="!progress?.unlocked" class="space-y-2" @submit.prevent="unlock">
      <h2 class="font-semibold">1. Setup code</h2>
      <p class="text-sm text-muted">The code is printed in the container log.</p>
      <label class="block text-sm" for="setup-code">Setup code</label>
      <input id="setup-code" v-model="code" class="input" autocomplete="off" required >
      <UButton type="submit" :loading="busy">Unlock</UButton>
    </form>

    <template v-else>
      <form class="space-y-2" @submit.prevent="saveApp">
        <h2 class="font-semibold">2. Discord application</h2>
        <p class="text-sm text-muted">
          Create an application in the Discord developer portal, add a bot, turn off Public Bot and turn on the Server
          Members and Message Content intents.
        </p>
        <p v-if="progress.clientId" class="text-sm">Saved for client ID {{ progress.clientId }}. Save again to replace it.</p>
        <label class="block text-sm" for="bot-token">Bot token</label>
        <input id="bot-token" v-model="app.botToken" class="input" type="password" autocomplete="off" required >
        <label class="block text-sm" for="client-id">Client ID</label>
        <input id="client-id" v-model="app.clientId" class="input" inputmode="numeric" autocomplete="off" required >
        <label class="block text-sm" for="client-secret">Client secret</label>
        <input id="client-secret" v-model="app.clientSecret" class="input" type="password" autocomplete="off" required >
        <UButton type="submit" :loading="busy">Save application</UButton>
      </form>

      <section v-if="progress.inviteUrl" class="space-y-2">
        <h2 class="font-semibold">3. Invite the bot and choose the server</h2>
        <p class="text-sm">
          <a :href="progress.inviteUrl" target="_blank" rel="noopener noreferrer" class="underline">Invite the bot to your server</a>,
          then choose that server.
        </p>
        <UButton variant="outline" :loading="busy" @click="loadGuilds">Load servers</UButton>
        <form v-if="guilds.length" class="space-y-2" @submit.prevent="chooseGuild">
          <label class="block text-sm" for="guild">Server</label>
          <select id="guild" v-model="guildId" class="input">
            <option v-for="g in guilds" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
          <UButton type="submit" :loading="busy">Use this server</UButton>
        </form>
        <p v-if="progress.guild" class="text-sm">Server: {{ progress.guild.name }}</p>
      </section>

      <section v-if="progress.guild" class="space-y-2">
        <h2 class="font-semibold">4. Log in as the owner</h2>
        <UAlert v-if="loginError" color="error" :title="loginError" />
        <p v-if="progress.ownerId" class="text-sm">Owner: Discord user {{ progress.ownerId }}.</p>
        <UButton to="/auth/discord" external variant="outline">Log in with Discord</UButton>
      </section>

      <form v-if="progress.ownerId && roles.length" class="space-y-2" @submit.prevent="saveRoles">
        <h2 class="font-semibold">5. Roles</h2>
        <p class="text-sm text-muted">
          Members with the organizer role can use everything; anyone who can hand out that role can make an organizer.
        </p>
        <label class="block text-sm" for="organizer-role">Organizer role</label>
        <select id="organizer-role" v-model="roleMap.organizerRoleId" class="input" required>
          <option v-for="r in roles" :key="r.id" :value="r.id">{{ r.name }}</option>
        </select>
        <label class="block text-sm" for="head-judge-role">Head judge role</label>
        <select id="head-judge-role" v-model="roleMap.headJudgeRoleId" class="input" required>
          <option v-for="r in roles" :key="r.id" :value="r.id">{{ r.name }}</option>
        </select>
        <UButton type="submit" :loading="busy">Save roles</UButton>
      </form>

      <section class="space-y-2">
        <h2 class="font-semibold">6. Checks</h2>
        <ul v-if="checks" class="space-y-1 text-sm" aria-label="Setup checks">
          <li v-for="c in checks.checks" :key="c.id" :data-check="c.id" :data-ok="c.ok">
            <span aria-hidden="true">{{ c.ok ? '✓' : '✗' }}</span> {{ describe(c) }}
          </li>
          <li v-for="w in checks.warnings" :key="w.id" class="text-warning">
            {{ w.id === 'bot_has_administrator' ? 'The bot has Administrator; it only needs the invite permissions.' : `The bot is also in: ${'guilds' in w ? w.guilds.map((g) => g.name).join(', ') : ''}.` }}
          </li>
        </ul>
        <div class="flex gap-2">
          <UButton variant="outline" :loading="busy" @click="recheck">Check again</UButton>
          <UButton :loading="busy" @click="finish">Finish setup</UButton>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.input {
  display: block;
  width: 100%;
  max-width: 28rem;
  border: 1px solid var(--ui-border-accented);
  border-radius: 0.375rem;
  padding: 0.375rem 0.5rem;
  background: var(--ui-bg);
}
</style>
