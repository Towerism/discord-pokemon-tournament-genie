<script setup lang="ts">
import { type DeliveryState, TOKEN_SCOPES_HELP, deliverySentence } from '#shared/delivery';

/**
 * Settings → Attendance: where attendance answers and its integration token (ADR-0008), and whether Genie is
 * delivering attendance's Discord messages (ADR-0017). The token is never shown.
 */
type Delivery = { delivery?: { state: DeliveryState } };
type Connection = ({ configured: false } | { configured: true; baseUrl: string; tokenHint: string; updatedAt: number }) & Delivery;

const connection = ref<Connection>({ configured: false });
const deliveryLine = computed(() => (connection.value.delivery ? deliverySentence(connection.value.delivery.state) : null));
const form = reactive({ baseUrl: '', token: '' });
const status = ref<string | null>(null);
const error = ref<string | null>(null);
const confirmingRemove = ref(false);

async function load() {
  connection.value = await apiFetch<Connection>('/api/settings/attendance');
  form.baseUrl = connection.value.configured ? connection.value.baseUrl : '';
}
onMounted(load);

async function save() {
  error.value = null;
  status.value = null;
  try {
    await apiFetch<Connection>('/api/settings/attendance', {
      method: 'PUT',
      body: { baseUrl: form.baseUrl.trim(), ...(form.token ? { token: form.token.trim() } : {}) },
    });
    form.token = '';
    // The save answers the connection only; reading it again brings the delivery state too.
    await load();
    status.value = 'Saved.';
  } catch (err) {
    error.value = errorCode(err) === 'token_required' ? 'Paste the token too: a new address needs it again.' : errorMessage(err);
  }
}

async function remove() {
  error.value = null;
  status.value = null;
  try {
    await apiFetch('/api/settings/attendance', { method: 'DELETE' });
    confirmingRemove.value = false;
    await load();
    status.value = 'Removed. Days keep what was already imported.';
  } catch (err) {
    error.value = errorMessage(err);
  }
}
</script>

<template>
  <form class="space-y-2" aria-labelledby="attendance-heading" @submit.prevent="save">
    <h2 id="attendance-heading" class="font-semibold">Attendance</h2>
    <p class="text-sm text-muted">
      Genie imports each day's tournaments and staff from attendance, and sends attendance's invites and notices to staff as Discord direct messages. Mint a token in attendance under Settings → Integrations and paste it here.
    </p>
    <p v-if="connection.configured" class="text-sm">
      Connected to <code>{{ connection.baseUrl }}</code> with token <code>{{ connection.tokenHint }}</code>.
    </p>
    <p v-else class="text-sm">Not connected.</p>
    <p v-if="deliveryLine" class="text-sm" data-testid="delivery-state">{{ deliveryLine }}</p>
    <label class="block text-sm" for="attendance-url">Attendance address</label>
    <input id="attendance-url" v-model="form.baseUrl" type="url" required placeholder="http://192.168.1.10:3000" class="w-full max-w-md border border-accented rounded p-2" >
    <label class="block text-sm" for="attendance-token">Integration token{{ connection.configured ? ' (leave empty to keep it)' : '' }}</label>
    <input id="attendance-token" v-model="form.token" type="password" autocomplete="off" aria-describedby="attendance-token-help" class="w-full max-w-md border border-accented rounded p-2" >
    <p id="attendance-token-help" class="text-sm text-muted">{{ TOKEN_SCOPES_HELP }}</p>
    <UAlert v-if="error" color="error" :title="error" />
    <p v-if="status" role="status" class="text-sm">{{ status }}</p>
    <div class="flex gap-2">
      <UButton type="submit">Save connection</UButton>
      <template v-if="connection.configured">
        <UButton v-if="!confirmingRemove" color="neutral" variant="outline" @click="confirmingRemove = true">Remove</UButton>
        <template v-else>
          <UButton color="error" @click="remove">Remove the connection</UButton>
          <UButton color="neutral" variant="ghost" @click="confirmingRemove = false">Keep it</UButton>
        </template>
      </template>
    </div>
  </form>
</template>
