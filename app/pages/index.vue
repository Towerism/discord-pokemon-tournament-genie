<script setup lang="ts">
const { user } = useUserSession();
const { data: me } = await useMe();
const organizer = computed(() => me.value?.isOrganizer === true);

// Organizers list every day; a head judge's days come with /api/me (FR-26, FR-45).
const { data: list, refresh } = await useFetch<{ days: DaySummary[] }>('/api/days', { immediate: organizer.value, default: () => ({ days: [] }) });
const days = computed(() => (organizer.value ? list.value.days : (me.value?.headJudgeDays ?? [])));

const { data: blueprints } = await useFetch<{ blueprints: { id: number; name: string; isDefault: boolean }[] }>('/api/blueprints', {
  immediate: organizer.value,
  default: () => ({ blueprints: [] }),
});
const { data: templates } = await useFetch<{ templates: { id: number; name: string }[] }>('/api/templates', {
  immediate: organizer.value,
  default: () => ({ templates: [] }),
});

const form = reactive({ date: '', title: '', from: '' });
const error = ref<string | null>(null);

async function createDay() {
  error.value = null;
  const [kind, id] = form.from.split(':');
  try {
    const plan = await apiFetch<{ day: { id: number } }>('/api/days', {
      method: 'POST',
      body: { date: form.date, title: form.title, ...(kind === 'template' ? { templateId: Number(id) } : kind === 'blueprint' ? { blueprintId: Number(id) } : {}) },
    });
    await refresh();
    await navigateTo(`/days/${plan.day.id}`);
  } catch (err) {
    error.value = errorMessage(err);
  }
}
</script>

<template>
  <section class="space-y-6">
    <div class="space-y-1">
      <h1 class="text-xl font-semibold">Event days</h1>
      <p>Signed in as {{ user?.globalName ?? user?.username }}.</p>
    </div>

    <p v-if="!days.length" class="text-muted">No event days yet.</p>
    <ul v-else class="divide-y divide-default border border-default rounded">
      <li v-for="day in days" :key="day.id" class="p-3 flex items-center gap-3">
        <NuxtLink :to="`/days/${day.id}`" class="font-medium underline">{{ day.title }}</NuxtLink>
        <span class="text-sm text-muted">{{ day.date }}</span>
        <UBadge :color="day.state === 'open' ? 'success' : 'neutral'" variant="subtle">{{ day.state }}</UBadge>
        <span class="ms-auto text-sm text-muted">{{ day.eventCount }} events · {{ day.staffCount }} staff</span>
      </li>
    </ul>

    <form v-if="organizer" class="space-y-2 max-w-md" @submit.prevent="createDay">
      <h2 class="font-semibold">Plan a day</h2>
      <label class="block text-sm" for="day-date">Date</label>
      <input id="day-date" v-model="form.date" type="date" required class="border border-accented rounded p-1" >
      <label class="block text-sm" for="day-title">Title</label>
      <input id="day-title" v-model="form.title" required maxlength="64" class="w-full border border-accented rounded p-1" >
      <label class="block text-sm" for="day-from">Start from</label>
      <select id="day-from" v-model="form.from" class="border border-accented rounded p-1">
        <option value="">The default blueprint</option>
        <option v-for="t in templates.templates" :key="`t${t.id}`" :value="`template:${t.id}`">Template: {{ t.name }}</option>
        <option v-for="b in blueprints.blueprints" :key="`b${b.id}`" :value="`blueprint:${b.id}`">Blueprint: {{ b.name }}</option>
      </select>
      <UAlert v-if="error" color="error" :title="error" />
      <UButton type="submit">Create day</UButton>
    </form>
  </section>
</template>
