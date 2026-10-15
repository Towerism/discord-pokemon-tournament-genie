<script setup lang="ts">
// Close-out (§6.5, §15 Q3): how long exports are kept after a day closes, and the attachment cap. The grace period
// comes from GENIE_PURGE_GRACE; transcripts must be kept longer than it.
interface CloseOut {
  transcriptRetentionDays: number;
  penaltyRetentionDays: number;
  attachmentCapMb: number;
  purgeGraceHours: number;
}

const props = defineProps<{ initial: CloseOut }>();
const form = reactive({ ...props.initial });
const grace = computed(() => (form.purgeGraceHours % 24 === 0 ? `${form.purgeGraceHours / 24} days` : `${form.purgeGraceHours} hours`));
const error = ref<string | null>(null);
const saved = ref<string | null>(null);

async function save() {
  error.value = null;
  saved.value = null;
  try {
    Object.assign(
      form,
      await apiFetch<CloseOut>('/api/settings/close-out', {
        method: 'PUT',
        body: { transcriptRetentionDays: form.transcriptRetentionDays, penaltyRetentionDays: form.penaltyRetentionDays, attachmentCapMb: form.attachmentCapMb },
      }),
    );
    saved.value = 'Saved.';
  } catch (err) {
    error.value = errorMessage(err);
  }
}
</script>

<template>
  <form class="space-y-2" aria-labelledby="closeout-heading" @submit.prevent="save">
    <h2 id="closeout-heading" class="font-semibold">Close-out</h2>
    <p class="text-sm">
      A closed day's channels stay locked for <strong data-testid="grace">{{ grace }}</strong> (set by <code>GENIE_PURGE_GRACE</code>), then are deleted once
      everything in them is exported. Exports are deleted after the periods below, counted from the day's close.
    </p>
    <div class="flex flex-wrap items-end gap-3 text-sm">
      <label>Keep transcripts (days)
        <input v-model.number="form.transcriptRetentionDays" type="number" min="1" max="3650" required class="block w-28 border border-accented rounded p-1" >
      </label>
      <label>Keep penalties and CSVs (days)
        <input v-model.number="form.penaltyRetentionDays" type="number" min="1" max="3650" required class="block w-28 border border-accented rounded p-1" >
      </label>
      <label>Attachment cap (MB)
        <input v-model.number="form.attachmentCapMb" type="number" min="1" max="500" required class="block w-28 border border-accented rounded p-1" >
      </label>
      <UButton type="submit">Save close-out</UButton>
    </div>
    <UAlert v-if="form.transcriptRetentionDays * 24 <= form.purgeGraceHours" color="warning" title="Keep transcripts longer than the grace period." />
    <UAlert v-if="error" color="error" :title="error" />
    <p v-if="saved" role="status" class="text-sm">{{ saved }}</p>
  </form>
</template>
