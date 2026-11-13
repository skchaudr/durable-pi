<script setup lang="ts">
import { computed, ref } from "vue";
import {
  Activity,
  Ban,
  Braces,
  Check,
  GitFork,
  Info,
  Layers,
  LoaderCircle,
  Octagon,
  RotateCcw,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-vue-next";
import type { ScriptCall } from "@sdk/api";
import type { TranscriptItem, ToolCallView } from "@sdk/transcript";
import { markdown } from "../client/markdown";
import { agentHandle, attempt, device, json, notify, primeChild } from "../client/store";
import { now, runByCall, runById, seconds } from "../client/jobs";
import JobCard from "./JobCard.vue";

defineProps<{ item: TranscriptItem }>();
const emit = defineEmits<{ fork: [entryId: number] }>();
// The revival and python-state cards are Prime's own; other devices never emit those kinds.
const prime = computed(() => device.value?.info?.durableVersion === "prime");
// Prime's revival_event JSON (pa-daemon revival_event.rs): which fields exist depends on `type`.
interface Revival {
  type?: string;
  outcome?: string;
  reason?: string;
  restarts?: number;
  failure?: number;
  maxFailures?: number;
  at?: string;
  interruptedToolCalls?: { toolCallId: string; toolName: string; started?: boolean }[];
}
const revival = (item: TranscriptItem) => ((item as { data?: { event?: Revival } }).data?.event ?? {}) as Revival;
const revivalTitle = (e: Revival) =>
  e.type === "worker_restarted"
    ? "Session worker restarted after a crash"
    : e.type === "revival_continued"
      ? "Interrupted turn continued after a restart"
      : e.outcome === "skipped"
        ? "Session not revived"
        : "Session revived after a crash";
// Worker failure events: a crash restart, or a session Prime did not revive. Retrying a worker that is already up is harmless.
const workerFailed = (e: Revival) => e.type === "worker_restarted" || (e.type === "revival" && e.outcome === "skipped");
const retrying = ref(false);
async function retryWorker() {
  const handle = agentHandle.value;
  if (!handle || retrying.value) return;
  retrying.value = true;
  if (await attempt(() => handle.retryWorker())) notify("Prime recovered the session worker.");
  retrying.value = false;
}
const pythonState = (item: TranscriptItem) =>
  ((item as { data?: { defined?: string[]; pruned?: string[] } }).data ?? {}) as { defined?: string[]; pruned?: string[] };
const statusLabel = (call: ToolCallView) =>
  call.status === "error" ? "Error" : call.status === "done" ? "Done" : call.status;
// A codemode call: its script is the argument worth previewing, and its nested calls render as a list.
const isScript = (call: ToolCallView) => call.name === "codemode";
const source = (call: ToolCallView) => String((call.args as { code?: unknown })?.code ?? "");
const preview = (call: ToolCallView) =>
  isScript(call)
    ? source(call).trim().replace(/\s+/g, " ").slice(0, 90)
    : json(call.args)?.slice(0, 90);
const callIcon = {
  running: LoaderCircle,
  ok: Check,
  error: X,
  interrupted: Octagon,
  cancelled: Ban,
} as const;
const callState = (c: ScriptCall) =>
  c.status === "running"
    ? c.startedAt
      ? seconds(now.value - c.startedAt)
      : "running"
    : c.status === "ok"
      ? c.durationMs !== undefined
        ? seconds(c.durationMs)
        : "ok"
      : c.status;
/** "3 calls, 1 running · 4.2s" while the script runs; "3 calls · 4.2s" once it settled. */
const progress = (call: ToolCallView) => {
  const calls = call.calls ?? [];
  const running = calls.filter((c) => c.status === "running").length;
  const parts = [
    `${calls.length} call${calls.length === 1 ? "" : "s"}${running ? `, ${running} running` : ""}`,
  ];
  if (call.startedAt)
    parts.push(
      seconds(
        (call.endedAt ?? (call.status === "running" ? now.value : call.startedAt)) - call.startedAt,
      ),
    );
  return parts.join(" · ");
};
const entryClass = (item: TranscriptItem) =>
  item.kind === "user"
    ? "pi-user"
    : item.kind === "assistant"
      ? item.streaming
        ? "live-generation"
        : "pi-assistant"
      : item.kind === "tool-result"
        ? "pi-tool-result"
        : item.kind === "tool"
          ? "live-tool-entry"
          : item.entryKind.replaceAll(".", "-");
</script>

<template>
  <article class="entry" :class="entryClass(item)">
    <template v-if="item.kind === 'user'"
      ><div class="message-label">
        YOU <span>#{{ item.id }}</span>
      </div>
      <div class="user-message">{{ item.text }}</div></template
    >
    <template v-else-if="item.kind === 'assistant'"
      ><div class="message-label">
        AGENT
        <span v-if="item.streaming" class="streaming">Working</span
        ><span v-else>#{{ item.id }}</span
        ><button
          v-if="!item.streaming && !primeChild"
          class="fork-button"
          :aria-label="`Fork at entry ${item.id}`"
          title="Fork from this entry. App State stays shared."
          @click="emit('fork', item.id as number)"
        >
          <GitFork :size="18" />Fork
        </button>
      </div>
      <template v-for="(b, j) in item.blocks" :key="j"
        ><div v-if="b.type === 'text'" class="markdown" v-html="markdown(b.text)" />
        <details v-else-if="b.type === 'thinking'" class="thinking">
          <summary>Thinking</summary>
          <div>{{ b.text }}</div>
        </details>
        <details
          v-else
          class="tool-call"
          :class="{ failed: b.call.status === 'error' }"
          :data-call-id="b.call.callId"
        >
          <summary>
            <Info v-if="b.call.status === 'error'" :size="18" />
            <Check v-else-if="b.call.status === 'done'" :size="18" />
            <Activity v-else-if="b.call.status === 'running'" :size="18" />
            <Wrench v-else :size="18" /><strong>{{ b.call.name }}</strong
            ><code>{{ preview(b.call) }}</code>
            <span v-if="isScript(b.call) && b.call.calls" class="script-progress">{{
              progress(b.call)
            }}</span>
            <span class="tool-status">{{ statusLabel(b.call) }}</span>
          </summary>
          <template v-if="isScript(b.call)">
            <details class="script-source">
              <summary>Script</summary>
              <pre>{{ source(b.call) }}</pre>
            </details>
            <div v-if="b.call.calls" class="tool-section-label">
              <span>Calls</span><span class="script-progress">{{ progress(b.call) }}</span>
            </div>
            <ol v-if="b.call.calls?.length" class="script-calls">
              <li
                v-for="c in b.call.calls"
                :key="c.id"
                :class="`st-${c.status}`"
                :data-script-call="c.id"
              >
                <div class="script-call-line">
                  <component
                    :is="callIcon[c.status]"
                    :size="15"
                    :class="{ spin: c.status === 'running' }"
                  />
                  <strong>{{ c.name }}</strong
                  ><code :title="c.args">{{ c.args }}</code>
                  <span class="script-call-state">{{ callState(c) }}</span>
                </div>
                <div v-if="c.error" class="script-call-error">{{ c.error }}</div>
              </li>
            </ol>
            <div v-else-if="b.call.calls" class="script-empty">No tool calls yet.</div>
          </template>
          <template v-else>
            <div class="tool-section-label">Input</div>
            <pre>{{ json(b.call.args) }}</pre>
          </template>
          <template v-if="b.call.result !== undefined">
            <div class="tool-section-label">
              <span>Result</span>
              <button
                v-if="b.call.resultEntryId !== undefined && !primeChild"
                class="fork-button"
                :aria-label="`Fork at entry ${b.call.resultEntryId}`"
                title="Fork after this result"
                @click="emit('fork', b.call.resultEntryId!)"
              >
                <GitFork :size="18" />Fork
              </button>
            </div>
            <pre>{{ b.call.result }}</pre>
          </template>
          <template v-else-if="b.call.output">
            <div class="tool-section-label">Live output</div>
            <pre>{{ b.call.output }}</pre>
          </template>
        </details>
        <JobCard
          v-if="b.type === 'tool' && b.call.name === 'run_durable_job' && runByCall(b.call.callId)"
          :run="runByCall(b.call.callId)!"
      /></template>
      <div v-if="item.streaming && !item.blocks.length" class="typing"><i /><i /><i /></div>
      <div v-if="item.error" class="message-error">{{ item.error }}</div></template
    >
    <template v-else-if="item.kind === 'tool-result'"
      ><details class="tool-result" :class="{ failed: item.isError }">
        <summary>
          <Check v-if="!item.isError" :size="18" /><Info v-else :size="18" /><strong>{{
            item.name
          }}</strong
          ><span>{{ item.isError ? "error" : "result" }}</span
          ><button
            v-if="!primeChild"
            class="fork-button"
            :aria-label="`Fork at entry ${item.id}`"
            @click.prevent="emit('fork', item.id)"
          >
            <GitFork :size="18" />Fork
          </button>
        </summary>
        <pre>{{ item.text }}</pre>
      </details></template
    >
    <div v-else-if="item.kind === 'tool'" class="live-tool">
      <div>
        <Activity :size="18" /><strong>{{ item.call.name }}</strong
        ><span>{{ item.call.status }}</span>
      </div>
      <pre v-if="item.call.output">{{ item.call.output }}</pre>
      <JobCard
        v-if="item.call.name === 'run_durable_job' && runByCall(item.call.callId)"
        :run="runByCall(item.call.callId)!"
      />
    </div>
    <JobCard
      v-else-if="item.entryKind === 'demo.job' && runById((item.data as { taskId: number }).taskId)"
      :run="runById((item.data as { taskId: number }).taskId)!"
    />
    <div v-else-if="prime && item.kind === 'event' && item.entryKind === 'prime.revival'" class="prime-card revival-card">
      <div class="prime-card-title">
        <RotateCcw :size="18" /><strong>{{ revivalTitle(revival(item)) }}</strong>
        <span v-if="revival(item).failure !== undefined" class="prime-card-meta"
          >failure {{ revival(item).failure }}<template v-if="revival(item).maxFailures !== undefined">/{{ revival(item).maxFailures }}</template></span
        ><span v-else-if="revival(item).restarts" class="prime-card-meta">restarts {{ revival(item).restarts }}</span
        ><span v-if="revival(item).at" class="prime-card-meta">{{ revival(item).at }}</span
        ><button
          v-if="workerFailed(revival(item))"
          class="fork-button"
          :disabled="retrying"
          title="Ask Prime to recover this session's worker (retry_worker)"
          @click="retryWorker"
        >
          <RotateCcw :size="18" />Retry worker
        </button>
      </div>
      <div v-if="revival(item).reason" class="prime-card-body">{{ revival(item).reason }}</div>
      <ul v-if="revival(item).interruptedToolCalls?.length" class="prime-card-calls">
        <li v-for="c in revival(item).interruptedToolCalls" :key="c.toolCallId">
          <code>{{ c.toolName }}</code
          ><span class="prime-chip" :class="c.started ? 'chip-started' : 'chip-never'">{{
            c.started ? "started" : "never started"
          }}</span>
        </li>
      </ul>
    </div>
    <div v-else-if="prime && item.kind === 'event' && item.entryKind === 'prime.python_state'" class="prime-card python-card">
      <div class="prime-card-title">
        <SquareTerminal :size="18" /><strong>Python kernel survived compaction</strong>
      </div>
      <div class="prime-card-body">
        <template v-if="pythonState(item).defined?.length"
          >Still defined:
          <span class="prime-chips"
            ><code v-for="n in pythonState(item).defined" :key="n" class="prime-chip">{{ n }}</code></span
          ></template
        ><template v-else-if="pythonState(item).defined">No names defined yet.</template>
      </div>
      <div v-if="pythonState(item).pruned?.length" class="prime-card-body">
        Removed (over the per-variable snapshot limit):
        <span class="prime-chips"
          ><code v-for="n in pythonState(item).pruned" :key="n" class="prime-chip chip-pruned">{{ n }}</code></span
        >
      </div>
    </div>
    <template v-else
      ><div class="event-line">
        <Braces v-if="item.entryKind === 'demo.state-change'" :size="18" /><Layers
          v-else
          :size="18"
        /><span>{{ item.text }}</span
        ><button
          v-if="!primeChild"
          class="fork-button"
          :aria-label="`Fork at entry ${item.id}`"
          @click="emit('fork', item.id)"
        >
          <GitFork :size="18" />Fork
        </button>
      </div>
      <details v-if="item.note" class="raw">
        <summary>Context note</summary>
        <pre>{{ item.note }}</pre>
      </details></template
    >
  </article>
</template>
