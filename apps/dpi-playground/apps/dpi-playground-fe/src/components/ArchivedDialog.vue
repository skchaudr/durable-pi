<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ArchiveRestore, X } from "lucide-vue-next";
import type { ArchivedSession } from "@sdk/api";
import { deviceClient, message } from "../client/hub";
import { ago, notify } from "../client/store";

const props = defineProps<{ deviceId: string }>();
const emit = defineEmits<{ close: [] }>();
const items = ref<ArchivedSession[]>();
const busy = ref("");
const error = ref("");
const client = deviceClient(props.deviceId);

onMounted(async () => {
  try {
    items.value = await client.archivedSessions();
  } catch (e) {
    error.value = message(e);
  }
});

async function restore(a: ArchivedSession) {
  if (busy.value) return;
  busy.value = a.id;
  error.value = "";
  try {
    await client.restoreSession(a.id);
    items.value = items.value?.filter((x) => x.id !== a.id);
    notify(`Restored ${a.name}.`);
  } catch (e) {
    error.value = message(e);
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="archived-title">
      <header>
        <h2 id="archived-title">Archived on {{ deviceId }}</h2>
        <button class="icon-button" aria-label="Close dialog" @click="emit('close')">
          <X :size="18" />
        </button>
      </header>
      <p v-if="items && !items.length" class="hint">No archived sessions.</p>
      <ul v-else-if="items" class="archived-list">
        <li v-for="a in items" :key="a.id">
          <span class="archived-name"
            ><b>{{ a.name }}</b
            ><small class="path">{{ a.cwd }}</small></span
          >
          <span v-if="a.archivedAt" class="meta">{{ ago(a.archivedAt) }}</span>
          <button
            class="secondary small"
            :disabled="!!busy"
            :aria-label="`Restore ${a.name}`"
            @click="restore(a)"
          >
            <ArchiveRestore :size="16" />{{ busy === a.id ? "Restoring…" : "Restore" }}
          </button>
        </li>
      </ul>
      <p v-if="error" class="message-error" role="alert">{{ error }}</p>
      <footer><button class="secondary" @click="emit('close')">Close</button></footer>
    </div>
  </div>
</template>
