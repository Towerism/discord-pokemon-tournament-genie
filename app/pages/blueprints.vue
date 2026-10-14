<script setup lang="ts">
interface Channel {
  key: string;
  scope: 'day' | 'per_event';
  kind: 'text';
  namePattern: string;
  audience: 'all_staff' | 'event_staff' | 'head_judges';
  purpose: 'general' | 'floor' | 'penalties';
  topic: string | null;
  position: number;
}
interface Blueprint {
  id: number;
  name: string;
  categoryNamePattern: string;
  isDefault: boolean;
  inUse: boolean;
  channels: Channel[];
}
interface Template {
  id: number;
  name: string;
  blueprintId: number;
  events: { name: string; game: string; startTime: string }[];
}

const { data: bp, refresh: refreshBlueprints } = await useFetch<{ blueprints: Blueprint[] }>('/api/blueprints', { default: () => ({ blueprints: [] }) });
const { data: tp, refresh: refreshTemplates } = await useFetch<{ templates: Template[] }>('/api/templates', { default: () => ({ templates: [] }) });
const error = ref<string | null>(null);
const problems = ref<{ path: string; code: string }[]>([]);

async function act(fn: () => Promise<unknown>) {
  error.value = null;
  problems.value = [];
  try {
    await fn();
    await Promise.all([refreshBlueprints(), refreshTemplates()]);
  } catch (err) {
    error.value = errorMessage(err);
    problems.value = (err as { data?: { data?: { problems?: { path: string; code: string }[] } } }).data?.data?.problems ?? [];
  }
}

// ---- one blueprint edited at a time; a copy is a new blueprint (an opened day's blueprint is frozen).
const editing = ref<(Omit<Blueprint, 'id' | 'isDefault' | 'inUse'> & { id: number | null }) | null>(null);
const edit = (b: Blueprint) => (editing.value = { id: b.id, name: b.name, categoryNamePattern: b.categoryNamePattern, channels: b.channels.map((c) => ({ ...c })) });
const copy = (b: Blueprint) => (editing.value = { id: null, name: `${b.name} (copy)`, categoryNamePattern: b.categoryNamePattern, channels: b.channels.map((c) => ({ ...c })) });
const addChannel = () =>
  editing.value!.channels.push({ key: '', scope: 'per_event', kind: 'text', namePattern: '{slug}-', audience: 'event_staff', purpose: 'general', topic: null, position: editing.value!.channels.length });
const saveBlueprint = () =>
  act(async () => {
    const { id, ...body } = editing.value!;
    if (id === null) await apiFetch('/api/blueprints', { method: 'POST', body });
    else await apiFetch(`/api/blueprints/${id}`, { method: 'PUT', body });
    editing.value = null;
  });
const removeBlueprint = (b: Blueprint) => act(() => apiFetch(`/api/blueprints/${b.id}`, { method: 'DELETE' }));

// ---- templates
const template = reactive({ name: '', blueprintId: 0, events: [] as { name: string; game: string; startTime: string }[] });
const addTemplateEvent = () => template.events.push({ name: '', game: 'tcg', startTime: '10:00' });
const saveTemplate = () =>
  act(async () => {
    await apiFetch('/api/templates', { method: 'POST', body: { ...template, blueprintId: template.blueprintId || bp.value.blueprints.find((b) => b.isDefault)?.id } });
    Object.assign(template, { name: '', blueprintId: 0, events: [] });
  });
const removeTemplate = (t: Template) => act(() => apiFetch(`/api/templates/${t.id}`, { method: 'DELETE' }));
const blueprintName = (id: number) => bp.value.blueprints.find((b) => b.id === id)?.name ?? '?';
</script>

<template>
  <section class="space-y-8">
    <h1 class="text-xl font-semibold">Blueprints and templates</h1>
    <UAlert v-if="error" color="error" :title="error" />
    <ul v-if="problems.length" class="text-sm text-error">
      <li v-for="p in problems" :key="`${p.path}${p.code}`">{{ p.path }}: {{ p.code.replaceAll('_', ' ') }}</li>
    </ul>

    <section aria-labelledby="bp-heading" class="space-y-3">
      <h2 id="bp-heading" class="font-semibold">Blueprints</h2>
      <p class="text-sm text-muted">Per-event channels are only ever for that event's staff or head judges; day channels for all of the day's staff or its head judges.</p>
      <div v-for="b in bp.blueprints" :key="b.id" class="border border-default rounded p-3 space-y-1">
        <div class="flex items-center gap-2">
          <strong>{{ b.name }}</strong>
          <UBadge v-if="b.isDefault" variant="subtle">default</UBadge>
          <span class="ms-auto flex gap-1">
            <UButton size="xs" variant="soft" @click="edit(b)">Edit</UButton>
            <UButton size="xs" variant="soft" @click="copy(b)">Copy</UButton>
            <UButton v-if="!b.isDefault && !b.inUse" size="xs" color="error" variant="ghost" @click="removeBlueprint(b)">Delete</UButton>
          </span>
        </div>
        <p class="text-sm">Category: {{ b.categoryNamePattern }}</p>
        <ul class="text-sm">
          <li v-for="c in b.channels" :key="c.key">#{{ c.namePattern }} · {{ c.scope === 'day' ? 'day' : 'per event' }} · {{ c.audience.replaceAll('_', ' ') }}</li>
        </ul>
      </div>

      <form v-if="editing" class="border border-accented rounded p-3 space-y-2" @submit.prevent="saveBlueprint">
        <h3 class="font-semibold">{{ editing.id === null ? 'New blueprint' : `Edit ${editing.name}` }}</h3>
        <label class="block text-sm">Name <input v-model="editing.name" required maxlength="64" class="block w-full border border-accented rounded p-1" ></label>
        <label class="block text-sm">Category name <input v-model="editing.categoryNamePattern" required class="block w-full border border-accented rounded p-1" ></label>
        <p class="text-xs text-muted">Tokens: {title} {date} {weekday}; in channels also {slug} and {event}.</p>
        <div v-for="(c, i) in editing.channels" :key="i" class="flex flex-wrap gap-2 items-end text-sm">
          <label>Key <input v-model="c.key" required maxlength="32" class="block border border-accented rounded p-1 w-28" ></label>
          <label>Name <input v-model="c.namePattern" required class="block border border-accented rounded p-1" ></label>
          <label>Scope
            <select v-model="c.scope" class="block border border-accented rounded p-1"><option value="day">Day</option><option value="per_event">Per event</option></select>
          </label>
          <label>Audience
            <select v-model="c.audience" class="block border border-accented rounded p-1">
              <option v-if="c.scope === 'day'" value="all_staff">All staff</option>
              <option v-if="c.scope === 'per_event'" value="event_staff">Event staff</option>
              <option value="head_judges">Head judges</option>
            </select>
          </label>
          <label>Purpose
            <select v-model="c.purpose" class="block border border-accented rounded p-1"><option value="general">General</option><option value="floor">Floor</option><option value="penalties">Penalties</option></select>
          </label>
          <UButton size="xs" variant="ghost" @click="editing.channels.splice(i, 1)">Remove</UButton>
        </div>
        <div class="flex gap-2">
          <UButton size="sm" variant="soft" @click="addChannel">Add channel</UButton>
          <UButton size="sm" type="submit">Save blueprint</UButton>
          <UButton size="sm" variant="ghost" @click="editing = null">Cancel</UButton>
        </div>
      </form>
    </section>

    <section aria-labelledby="tp-heading" class="space-y-3">
      <h2 id="tp-heading" class="font-semibold">Day templates</h2>
      <div v-for="t in tp.templates" :key="t.id" class="flex items-center gap-2 text-sm">
        <strong>{{ t.name }}</strong>
        <span>({{ blueprintName(t.blueprintId) }}): {{ t.events.map((e) => `${e.name} ${e.startTime}`).join(', ') || 'no events' }}</span>
        <UButton size="xs" color="error" variant="ghost" @click="removeTemplate(t)">Delete</UButton>
      </div>
      <form class="space-y-2" @submit.prevent="saveTemplate">
        <label class="block text-sm">Template name <input v-model="template.name" required maxlength="64" class="block border border-accented rounded p-1" ></label>
        <label class="block text-sm">Blueprint
          <select v-model.number="template.blueprintId" class="block border border-accented rounded p-1">
            <option :value="0">The default</option>
            <option v-for="b in bp.blueprints" :key="b.id" :value="b.id">{{ b.name }}</option>
          </select>
        </label>
        <div v-for="(e, i) in template.events" :key="i" class="flex gap-2 items-end text-sm">
          <label>Event <input v-model="e.name" required maxlength="64" class="block border border-accented rounded p-1" ></label>
          <label>Game
            <select v-model="e.game" class="block border border-accented rounded p-1"><option value="tcg">TCG</option><option value="vgc">VGC</option><option value="go">GO</option><option value="other">Other</option></select>
          </label>
          <label>Start <input v-model="e.startTime" type="time" required class="block border border-accented rounded p-1" ></label>
        </div>
        <div class="flex gap-2">
          <UButton size="sm" variant="soft" @click="addTemplateEvent">Add event</UButton>
          <UButton size="sm" type="submit">Save template</UButton>
        </div>
      </form>
    </section>
  </section>
</template>
