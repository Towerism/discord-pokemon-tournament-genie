<script setup lang="ts">
import type { NuxtError } from '#app';

const props = defineProps<{ error: NuxtError }>();
const notFound = computed(() => props.error.statusCode === 404);
</script>

<template>
  <UApp>
    <main class="mx-auto max-w-3xl p-4 space-y-4">
      <h1 class="text-xl font-semibold">{{ notFound ? 'Page not found' : 'Something went wrong' }}</h1>
      <p>{{ notFound ? 'There is no page at this address.' : 'Try again, or go back to the start.' }}</p>
      <UButton @click="clearError({ redirect: '/' })">Back to Tournament Genie</UButton>
    </main>
  </UApp>
</template>
