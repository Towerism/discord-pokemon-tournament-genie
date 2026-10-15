<script setup lang="ts">
// The penalty catalog (§6.7, ADR-0006): the current season, and per season the categories and penalties `/penalty`
// offers. Rows are never deleted, only deactivated, because recorded penalties refer to them.
type Game = 'tcg' | 'vgc' | 'go' | 'other';
interface Row {
  id?: number;
  label: string;
  games: Game[];
  rank: number;
  active: boolean;
}
interface Catalog {
  currentSeason: string;
  seasons: string[];
  season: string;
  categories: Row[];
  types: Row[];
}

const GAMES: { value: Game; label: string }[] = [
  { value: 'tcg', label: 'TCG' },
  { value: 'vgc', label: 'VGC' },
  { value: 'go', label: 'GO' },
  { value: 'other', label: 'Other' },
];
const LISTS = [
  { key: 'categories', title: 'Categories' },
  { key: 'types', title: 'Penalties' },
] as const;

const catalog = ref<Catalog | null>(null);
const season = ref('');
const error = ref<string | null>(null);
const saved = ref<string | null>(null);
const next = reactive({ season: '', copyFrom: '' });

async function load(s?: string) {
  catalog.value = await apiFetch<Catalog>('/api/catalog', s ? { query: { season: s } } : {});
  season.value = catalog.value.season;
}
onMounted(() => load());

async function run(fn: () => Promise<unknown>, done: string) {
  error.value = null;
  saved.value = null;
  try {
    await fn();
    saved.value = done;
  } catch (err) {
    error.value = errorMessage(err);
  }
}

const save = () =>
  run(async () => {
    const c = catalog.value!;
    catalog.value = await apiFetch<Catalog>(`/api/catalog/${encodeURIComponent(c.season)}`, { method: 'PUT', body: { categories: c.categories, types: c.types } });
  }, 'Catalog saved.');

const setSeason = () =>
  run(async () => {
    const isNew = !catalog.value?.seasons.includes(next.season);
    await apiFetch('/api/settings/season', { method: 'PUT', body: { season: next.season, ...(isNew ? { copyFrom: next.copyFrom || catalog.value!.currentSeason } : {}) } });
    await load(next.season);
  }, 'Current season set. New days use it; existing days keep theirs.');

function toggle(row: Row, game: Game) {
  row.games = row.games.includes(game) ? row.games.filter((g) => g !== game) : [...row.games, game];
}
function add(list: 'categories' | 'types') {
  const rows = catalog.value![list];
  rows.push({ label: '', games: ['tcg', 'vgc', 'go', 'other'], rank: Math.max(0, ...rows.map((r) => r.rank)) + 1, active: true });
}
</script>

<template>
  <section v-if="catalog" aria-labelledby="catalog-heading" class="space-y-4">
    <h2 id="catalog-heading" class="font-semibold">Penalty catalog</h2>
    <p class="text-sm">
      Current season: <strong data-testid="current-season">{{ catalog.currentSeason }}</strong>. A new day copies it; `/penalty` offers that season's rows for the event's game.
    </p>

    <form class="flex flex-wrap items-end gap-2 text-sm" @submit.prevent="setSeason">
      <label class="flex flex-col">Set the current season<input v-model="next.season" class="border border-accented rounded p-1" placeholder="2027-28" required ></label>
      <label v-if="next.season && !catalog.seasons.includes(next.season)" class="flex flex-col">
        Start it as a copy of
        <select v-model="next.copyFrom" class="border border-accented rounded p-1">
          <option v-for="s in catalog.seasons" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <UButton type="submit" variant="outline">Set season</UButton>
    </form>

    <label class="flex items-center gap-2 text-sm">
      Season shown
      <select v-model="season" class="border border-accented rounded p-1" @change="load(season)">
        <option v-for="s in catalog.seasons" :key="s" :value="s">{{ s }}</option>
      </select>
    </label>

    <form class="space-y-4" @submit.prevent="save">
      <fieldset v-for="list in LISTS" :key="list.key" class="space-y-1">
        <legend class="font-medium">{{ list.title }}</legend>
        <table class="text-sm">
          <thead>
            <tr class="text-left"><th>Label</th><th>Games</th><th>Rank</th><th>Active</th></tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in catalog[list.key]" :key="row.id ?? `new-${i}`">
              <td><input v-model="row.label" :aria-label="`${list.title} label ${i + 1}`" class="border border-accented rounded p-1" maxlength="100" required ></td>
              <td>
                <label v-for="g in GAMES" :key="g.value" class="mr-2 inline-flex items-center gap-1">
                  <input type="checkbox" :checked="row.games.includes(g.value)" @change="toggle(row, g.value)" >{{ g.label }}
                </label>
              </td>
              <td><input v-model.number="row.rank" type="number" min="0" max="999" class="w-16 border border-accented rounded p-1" :aria-label="`${list.title} rank ${i + 1}`" ></td>
              <td><input v-model="row.active" type="checkbox" :aria-label="`${list.title} active ${i + 1}`" ></td>
            </tr>
          </tbody>
        </table>
        <UButton size="sm" variant="ghost" @click="add(list.key)">Add a row</UButton>
      </fieldset>
      <UAlert v-if="error" color="error" :title="error" />
      <p v-if="saved" role="status" class="text-sm">{{ saved }}</p>
      <UButton type="submit">Save catalog</UButton>
    </form>
  </section>
</template>
