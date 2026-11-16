<script setup lang="ts">
import { computed, ref } from "vue";
import { Bot, ChevronDown, GitBranch, GitCommitHorizontal, Rocket, Siren } from "lucide-vue-next";
import type { Deploy, Incident } from "../../../../../proactive-dpi-demo/shared/types";
import { attempt, notify } from "../client/store";
import { decideDeploy, openRemote, remoteDevice, reviewOf, STATUS_LABELS, STEPS, type Review } from "../client/ops";

const props = defineProps<{ incident: Incident; deploys: Deploy[] }>();
const open = ref(false);
const review = ref<Review>();
const loading = ref(false);
const deciding = ref(false);
const error = ref("");
const reached = computed(() => STEPS.indexOf(props.incident.status));
const deployed = computed(() => props.incident.status === "deployed");
const waiting = computed(() => props.deploys.find((d) => d.status === "awaiting_approval"));
const rolling = computed(() => props.deploys.find((d) => d.status === "deploying" || d.status === "verifying"));
const time = (t: number | string) => new Date(t).toLocaleTimeString();
const diffLines = computed(() =>
  (review.value?.diff ?? "").split("\n").map((text) => ({
    text,
    kind: /^(\+\+\+|---)/.test(text) ? "file" : text[0] === "+" ? "add" : text[0] === "-" ? "del" : text[0] === "@" ? "hunk" : "",
  })),
);

async function loadReview() {
  loading.value = true;
  error.value = "";
  try {
    review.value = await reviewOf(props.incident.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
async function decide(approved: boolean) {
  if (!waiting.value || deciding.value) return;
  deciding.value = true;
  error.value = "";
  const sent = await attempt(() => decideDeploy(waiting.value!.id, approved));
  deciding.value = false;
  if (sent) notify(approved ? "Deploy approved. Rolling out." : "Deploy declined. Nothing shipped.");
}
</script>

<template>
  <section class="incident-card" :class="incident.status" :data-incident="incident.id">
    <button class="incident-top" :aria-expanded="open" @click="open = !open">
      <Siren :size="18" />
      <strong>{{ incident.id }}</strong>
      <span class="incident-title">{{ incident.title }}</span>
      <span class="incident-status"><i />{{ STATUS_LABELS[incident.status] }}</span>
      <ChevronDown :size="18" :class="{ flipped: open }" />
    </button>
    <ol class="incident-steps" aria-label="Progress">
      <li
        v-for="(step, i) in STEPS"
        :key="step"
        :title="STATUS_LABELS[step]"
        :class="{ done: i < reached || (deployed && i === reached), current: i === reached && !deployed }"
      >
        <i />
      </li>
    </ol>
    <p class="incident-summary">{{ incident.summary }}</p>
    <div v-if="incident.remote" class="incident-remote">
      <span class="tag">{{ incident.remote.backend }}</span>
      <button class="text-button" :disabled="!remoteDevice(incident.remote.sessionId)" @click="openRemote(incident.remote)">
        <Bot :size="16" />Open agent
      </button>
      <small v-if="!remoteDevice(incident.remote.sessionId)">Not on a device in this hub.</small>
    </div>
    <section v-if="waiting" class="deploy-card" aria-label="Deploy approval">
      <div class="deploy-head"><Rocket :size="18" /><strong>Deploy waiting for your approval</strong></div>
      <p>{{ waiting.summary }}</p>
      <div class="deploy-meta"><GitCommitHorizontal :size="16" />{{ waiting.commit }} on {{ waiting.branch }}</div>
      <pre v-if="waiting.diffStat">{{ waiting.diffStat }}</pre>
      <div class="deploy-actions">
        <button class="secondary" :disabled="deciding" @click="decide(false)">Decline</button>
        <button class="primary small" :disabled="deciding" @click="decide(true)"><Rocket :size="16" />Approve deploy</button>
      </div>
    </section>
    <p v-else-if="rolling" class="deploy-rolling">
      <Rocket :size="16" />{{ rolling.status === "deploying" ? "Rolling out" : "Verifying" }} {{ rolling.revision ?? "a new revision" }}
    </p>
    <p v-if="error" class="message-error" role="alert">{{ error }}</p>
    <div v-if="open" class="incident-body">
      <dl class="incident-facts">
        <div><dt>Fingerprint</dt><dd>{{ incident.fingerprint }}</dd></div>
        <div>
          <dt>Live revision</dt>
          <dd>{{ incident.evidence.revision }}<template v-if="incident.evidence.commit"> ({{ incident.evidence.commit }})</template></dd>
        </div>
        <div><dt>Opened</dt><dd>{{ time(incident.openedAt) }}, first error {{ time(incident.evidence.firstSeen) }}</dd></div>
        <div><dt>Branch</dt><dd><GitBranch :size="16" />{{ incident.branch }}</dd></div>
      </dl>
      <dl v-if="incident.report.rootCause || incident.report.fix || incident.report.tests" class="incident-report">
        <div v-if="incident.report.rootCause"><dt>Root cause</dt><dd>{{ incident.report.rootCause }}</dd></div>
        <div v-if="incident.report.fix"><dt>Fix</dt><dd>{{ incident.report.fix }}</dd></div>
        <div v-if="incident.report.tests"><dt>Tests</dt><dd>{{ incident.report.tests }}</dd></div>
      </dl>
      <div class="incident-actions">
        <button class="secondary" :disabled="loading" @click="loadReview">
          <GitCommitHorizontal :size="18" />{{ review ? "Refresh diff" : "View diff" }}
        </button>
        <span v-if="review" class="hint">{{ review.ahead }} commit{{ review.ahead === 1 ? "" : "s" }} ahead of main</span>
      </div>
      <template v-if="review">
        <pre v-if="review.log" class="review-log">{{ review.log }}</pre>
        <pre v-if="review.diff" class="diff"><span v-for="(line, i) in diffLines" :key="i" :class="line.kind">{{ line.text }}
</span></pre>
        <p v-else class="hint">No changes on the branch yet.</p>
      </template>
    </div>
  </section>
</template>
