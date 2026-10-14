<script setup lang="ts">
const route = useRoute();
const config = useRuntimeConfig();

const reasons: Record<string, string> = {
  not_in_guild: 'You need to be a member of the store’s Discord server.',
  no_access: 'Your Discord account doesn’t have organizer access. Ask the organizer.',
  setup_incomplete: 'Setup isn’t finished yet.',
  login_failed: 'The Discord login didn’t complete. Try again.',
  discord_unavailable: 'Discord couldn’t be reached. Try again in a moment.',
};
const error = computed(() => reasons[String(route.query.error ?? '')] ?? null);

// ADR-0013: logins only work on the https:// site address, or on localhost on the host itself.
const wrongOrigin = computed(() => {
  if (!import.meta.client) return false;
  const { origin, hostname } = window.location;
  const site = config.public.siteUrl ? new URL(config.public.siteUrl).origin : null;
  return origin !== site && hostname !== 'localhost';
});
</script>

<template>
  <section class="space-y-4">
    <h1 class="text-xl font-semibold">Log in</h1>
    <UAlert v-if="error" color="error" :title="error" />
    <UAlert
      v-if="wrongOrigin"
      color="warning"
      title="Open Genie through its https:// address"
      description="Logging in only works on the address Caddy serves Genie on, or on localhost on the host itself."
    />
    <UButton to="/auth/discord" external>Log in with Discord</UButton>
  </section>
</template>
