<script setup lang="ts">
const { user } = useUserSession();
</script>

<template>
  <section class="space-y-2">
    <h1 class="text-xl font-semibold">Event days</h1>
    <p>Signed in as {{ user?.globalName ?? user?.username }}.</p>
    <p class="text-muted">No event days yet.</p>
  </section>
</template>
