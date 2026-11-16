<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { followOps, deploys, incidents, opsError, opsState } from "../client/ops";
import IncidentCard from "./IncidentCard.vue";

const abort = new AbortController();
onMounted(() => void followOps(abort.signal));
onBeforeUnmount(() => abort.abort());
const sorted = computed(() => [...incidents.value].sort((a, b) => b.openedAt - a.openedAt));
</script>

<template>
  <div class="incidents-panel">
    <div class="panel-heading">
      <h2>Incidents</h2>
      <span class="tag" :class="{ completed: opsState === 'live' }">{{ opsState === "live" ? `${incidents.length} live` : opsState }}</span>
    </div>
    <p class="hint">
      Incidents the proactive demo's agents are working, with the deploys that wait for your approval. Served by the ops
      service through this hub.
    </p>
    <p v-if="opsState === 'down'" class="message-error" role="alert">
      Ops service unreachable{{ opsError ? `: ${opsError}` : "" }}. Retrying.
    </p>
    <p v-else-if="opsState === 'live' && !incidents.length" class="task-empty">No incidents.</p>
    <IncidentCard
      v-for="i in sorted"
      :key="i.id"
      :incident="i"
      :deploys="deploys.filter((d) => d.incidentId === i.id)"
    />
  </div>
</template>
