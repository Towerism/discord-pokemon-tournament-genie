<script setup lang="ts">
// The penalty's fields, as the clipboard sheet has them (§6.4): shared by recording and editing on the website.
interface Option {
  id: number;
  label: string;
}
interface Form {
  judgeStaffMemberId: number | null;
  round: number | null;
  competitorPlayerId: string;
  categoryId: number | null;
  severity: 'Minor' | 'Major' | 'Severe';
  penaltyTypeId: number | null;
  notes: string;
}

defineProps<{ event: { judges: { staffMemberId: number; name: string; playerId: string }[]; options: { categories: Option[]; types: Option[] } } }>();
const form = defineModel<Form>({ required: true });
const id = useId();
</script>

<template>
  <label :for="`${id}-judge`">Judge</label>
  <select :id="`${id}-judge`" v-model="form.judgeStaffMemberId" class="border border-accented rounded p-1" required>
    <option v-for="j in event.judges" :key="j.staffMemberId" :value="j.staffMemberId">{{ j.name }} ({{ j.playerId }})</option>
  </select>
  <label :for="`${id}-round`">Round</label>
  <input :id="`${id}-round`" v-model.number="form.round" type="number" min="1" max="99" class="w-20 border border-accented rounded p-1" required >
  <label :for="`${id}-player`">Competitor's player ID</label>
  <input :id="`${id}-player`" v-model.trim="form.competitorPlayerId" inputmode="numeric" pattern="\d{1,10}" maxlength="10" class="border border-accented rounded p-1" required >
  <label :for="`${id}-category`">Category</label>
  <select :id="`${id}-category`" v-model="form.categoryId" class="border border-accented rounded p-1" required>
    <option v-for="o in event.options.categories" :key="o.id" :value="o.id">{{ o.label }}</option>
  </select>
  <label :for="`${id}-severity`">Severity</label>
  <select :id="`${id}-severity`" v-model="form.severity" class="border border-accented rounded p-1" required>
    <option v-for="s in ['Minor', 'Major', 'Severe']" :key="s" :value="s">{{ s }}</option>
  </select>
  <label :for="`${id}-penalty`">Penalty</label>
  <select :id="`${id}-penalty`" v-model="form.penaltyTypeId" class="border border-accented rounded p-1" required>
    <option v-for="o in event.options.types" :key="o.id" :value="o.id">{{ o.label }}</option>
  </select>
  <label :for="`${id}-notes`">Notes</label>
  <textarea :id="`${id}-notes`" v-model="form.notes" maxlength="1000" class="border border-accented rounded p-1" />
</template>
