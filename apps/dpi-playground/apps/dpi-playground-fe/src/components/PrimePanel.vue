<script setup lang="ts">
// Prime's own durable work for the selected session: its goal, its heartbeat and its schedules. Live from the session
// stream (`prime_work` frames, which carry goal_update and heartbeat changes); every button calls the backend, never the
// chat. A goal is a /goal message, so a busy agent queues it instead of refusing it.
import { computed, reactive, ref } from "vue";
import { CalendarClock, HeartPulse, Pause, Pencil, Play, Plus, Target, Trash2, X } from "lucide-vue-next";
import type { PrimeJob } from "@sdk/prime";
import { attempt, notify, session, sessionHandle } from "../client/store";

const SCHEDULE_HELP = 'in 30m (once) · every 1h · at 2026-12-01T09:00:00Z (once) · or a 5-field cron expression';

const work = computed(() => session.state.value.primeWork);
const goal = computed(() => work.value?.goal ?? undefined);
const heartbeat = computed(() => work.value?.heartbeat ?? undefined);
const schedules = computed(() => work.value?.schedules ?? []);

const STATUS: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  budget_limited: "Budget reached",
  complete: "Complete",
  error: "Error",
};
const tokens = (n: number) => n.toLocaleString("en-US");
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "");
const elapsed = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
const used = computed(() => {
  const g = goal.value;
  return g?.tokenBudget ? Math.min(100, (100 * g.tokensUsed) / g.tokenBudget) : 0;
});

// One call at a time: buttons wait for the answer, and the stream shows the result.
const pending = ref("");
async function act<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (pending.value) return;
  pending.value = key;
  try {
    return await attempt(fn);
  } finally {
    pending.value = "";
  }
}

// ------------------------------------------------------------------ goal
const goalForm = reactive({ open: false, objective: "", budget: "" });
const budgetNumber = computed(() => (goalForm.budget.trim() === "" ? 0 : Number(goalForm.budget)));
const budgetOk = computed(() => Number.isInteger(budgetNumber.value) && budgetNumber.value >= 0);
const showGoalForm = computed(() => goalForm.open || !goal.value);

function openGoalForm() {
  goalForm.open = true;
  goalForm.objective = "";
  goalForm.budget = "";
}
async function setGoal() {
  const h = sessionHandle.value;
  if (!h || !goalForm.objective.trim() || !budgetOk.value) return;
  const r = await act("goal:set", () => h.setPrimeGoal(goalForm.objective.trim(), budgetNumber.value));
  if (!r) return;
  goalForm.open = false;
  goalForm.objective = "";
  goalForm.budget = "";
  notify(r.queued ? "Queued: the agent is busy, so the goal starts when its turn ends." : "Goal sent.");
}
async function goalAction(action: "pause" | "resume" | "clear") {
  const h = sessionHandle.value;
  const r = h && (await act(`goal:${action}`, () => h.primeGoal(action)));
  if (r?.queued) notify(`Queued: the agent is busy, so /goal ${action} runs when its turn ends.`);
}

// ------------------------------------------------------------------ heartbeat
const hbForm = reactive({ open: false, schedule: "every 1h", prompt: "", deliveryMode: "" });
const showHbForm = computed(() => hbForm.open || !heartbeat.value);
function openHbForm() {
  const hb = heartbeat.value;
  Object.assign(hbForm, { open: true, schedule: hb?.schedule ?? "every 1h", prompt: hb?.prompt ?? "", deliveryMode: hb?.deliveryMode ?? "" });
}
async function setHeartbeat() {
  const h = sessionHandle.value;
  if (!h || !hbForm.schedule.trim() || !hbForm.prompt.trim()) return;
  const r = await act("hb:set", () =>
    h.setPrimeHeartbeat({
      schedule: hbForm.schedule.trim(),
      prompt: hbForm.prompt.trim(),
      ...(hbForm.deliveryMode ? { deliveryMode: hbForm.deliveryMode as "steer" | "follow_up" } : {}),
    }),
  );
  if (r) hbForm.open = false;
}
const heartbeatAction = (job: PrimeJob, action: "pause" | "resume" | "stop") => {
  const h = sessionHandle.value;
  return h && act(`hb:${action}`, () => h.primeHeartbeat(job.id, action));
};

// ------------------------------------------------------------------ schedules
// editing: "" (closed), "new", or the id of the schedule being edited.
const schedForm = reactive({ editing: "", schedule: "", prompt: "" });
const note = ref("");
function openSchedForm(job?: PrimeJob) {
  Object.assign(schedForm, { editing: job?.id ?? "new", schedule: job?.schedule ?? "in 1h", prompt: job?.prompt ?? "" });
}
async function saveSchedule() {
  const h = sessionHandle.value;
  if (!h || !schedForm.schedule.trim() || !schedForm.prompt.trim()) return;
  const body = { schedule: schedForm.schedule.trim(), prompt: schedForm.prompt.trim() };
  const editing = schedForm.editing;
  note.value = "";
  const r = await act<PrimeJob | { job: PrimeJob; replaced: string }>("sched:save", () =>
    editing === "new" ? h.addPrimeSchedule(body) : h.editPrimeSchedule(editing, body),
  );
  if (!r) return;
  schedForm.editing = "";
  if ("replaced" in r) note.value = `Prime has no edit command, so the schedule was cancelled and added again. Its id changed: ${r.replaced} → ${r.job.id}.`;
}
async function cancelSchedule(job: PrimeJob) {
  const h = sessionHandle.value;
  note.value = "";
  if (h) await act(`sched:cancel:${job.id}`, () => h.cancelPrimeSchedule(job.id));
}
</script>

<template>
  <div class="prime-panel">
    <div class="panel-heading">
      <h2>Prime work</h2>
      <Target :size="18" />
    </div>
    <p class="hint">
      Prime's goal, heartbeat and schedules for this session. They run on Prime, not on this page, and show here live.
    </p>
    <p v-if="!work" class="task-empty">Loading…</p>

    <template v-else>
      <!-- goal -->
      <article class="ext-card prime-card" :class="{ on: goal?.status === 'active' }" data-prime="goal">
        <div class="ext-head">
          <div>
            <strong><Target :size="16" /> Goal</strong>
            <span v-if="goal" class="tag" :class="goal.status">{{ STATUS[goal.status] ?? goal.status }}</span>
            <span v-else class="tag">None</span>
          </div>
        </div>
        <template v-if="goal">
          <p class="prime-text" data-prime="objective">{{ goal.objective }}</p>
          <div v-if="goal.tokenBudget" data-prime="budget">
            <div
              class="progress"
              role="progressbar"
              aria-label="Goal token budget used"
              :aria-valuenow="Math.round(used)"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <div :style="{ width: `${used}%` }" />
            </div>
            <div class="job-meta">
              <span>{{ tokens(goal.tokensUsed) }} / {{ tokens(goal.tokenBudget) }} tokens</span><span>{{ Math.round(used) }}%</span>
            </div>
          </div>
          <p v-else class="prime-meta" data-prime="budget">{{ tokens(goal.tokensUsed) }} tokens used, no budget</p>
          <p class="prime-meta">
            {{ elapsed(goal.timeUsedSeconds) }} · {{ goal.continuationsUsed }} continuation{{ goal.continuationsUsed === 1 ? "" : "s" }}
          </p>
          <p v-if="goal.reason" class="prime-meta">{{ goal.reason }}</p>
          <div class="prime-actions">
            <button v-if="goal.status === 'active'" class="secondary" :disabled="!!pending" @click="goalAction('pause')">
              <Pause :size="16" />Pause
            </button>
            <button v-if="goal.status === 'paused'" class="secondary" :disabled="!!pending" @click="goalAction('resume')">
              <Play :size="16" />Resume
            </button>
            <button class="secondary danger" :disabled="!!pending" @click="goalAction('clear')"><Trash2 :size="16" />Clear</button>
            <button v-if="!goalForm.open" class="secondary" :disabled="!!pending" @click="openGoalForm"><Pencil :size="16" />New goal</button>
          </div>
        </template>
        <form v-if="showGoalForm" class="prime-form" data-prime="goal-form" @submit.prevent="setGoal">
          <label class="field-label" for="prime-goal-objective">{{ goal ? "New goal (replaces this one)" : "Objective" }}</label>
          <textarea id="prime-goal-objective" v-model="goalForm.objective" rows="3" placeholder="What Prime should keep working toward" />
          <label class="field-label" for="prime-goal-budget">Token budget (optional)</label>
          <input id="prime-goal-budget" v-model="goalForm.budget" inputmode="numeric" placeholder="none" />
          <p v-if="!budgetOk" class="message-error" role="alert">The budget is a whole number of tokens, or empty for none.</p>
          <div class="prime-actions">
            <button class="primary small" type="submit" :disabled="!!pending || !goalForm.objective.trim() || !budgetOk">
              Set goal
            </button>
            <button v-if="goal" class="secondary" type="button" @click="goalForm.open = false"><X :size="16" />Cancel</button>
          </div>
          <p class="prime-meta">Sent as /goal. While the agent is busy it queues behind the running turn.</p>
        </form>
      </article>

      <!-- heartbeat -->
      <article class="ext-card prime-card" :class="{ on: heartbeat?.status === 'active' }" data-prime="heartbeat">
        <div class="ext-head">
          <div>
            <strong><HeartPulse :size="16" /> Heartbeat</strong>
            <span v-if="heartbeat" class="tag">{{ heartbeat.status === "paused" ? "Paused" : "Active" }}</span>
            <span v-else class="tag">None</span>
          </div>
        </div>
        <template v-if="heartbeat">
          <p class="prime-meta"><code>{{ heartbeat.schedule }}</code><span v-if="heartbeat.deliveryMode"> · {{ heartbeat.deliveryMode === "steer" ? "steers a busy turn" : "waits for the turn" }}</span></p>
          <p class="prime-text" data-prime="prompt">{{ heartbeat.prompt }}</p>
          <p class="prime-meta">
            <template v-if="heartbeat.nextRunAt && heartbeat.status === 'active'">Next {{ when(heartbeat.nextRunAt) }} · </template>{{ heartbeat.runCount }} run{{ heartbeat.runCount === 1 ? "" : "s" }}
          </p>
          <div class="prime-actions">
            <button v-if="heartbeat.status === 'active'" class="secondary" :disabled="!!pending" @click="heartbeatAction(heartbeat, 'pause')">
              <Pause :size="16" />Pause
            </button>
            <button v-else class="secondary" :disabled="!!pending" @click="heartbeatAction(heartbeat, 'resume')"><Play :size="16" />Resume</button>
            <button v-if="!hbForm.open" class="secondary" :disabled="!!pending" @click="openHbForm"><Pencil :size="16" />Edit</button>
            <button class="secondary danger" :disabled="!!pending" @click="heartbeatAction(heartbeat, 'stop')"><Trash2 :size="16" />Stop</button>
          </div>
        </template>
        <form v-if="showHbForm" class="prime-form" data-prime="heartbeat-form" @submit.prevent="setHeartbeat">
          <label class="field-label" for="prime-hb-schedule">Schedule</label>
          <input id="prime-hb-schedule" v-model="hbForm.schedule" placeholder="every 1h" />
          <label class="field-label" for="prime-hb-prompt">Prompt</label>
          <textarea id="prime-hb-prompt" v-model="hbForm.prompt" rows="3" placeholder="What each beat tells Prime" />
          <label class="field-label" for="prime-hb-mode">When the agent is busy</label>
          <select id="prime-hb-mode" v-model="hbForm.deliveryMode">
            <option value="">Keep Prime's setting</option>
            <option value="steer">Steer the running turn</option>
            <option value="follow_up">Wait for the turn to end</option>
          </select>
          <div class="prime-actions">
            <button class="primary small" type="submit" :disabled="!!pending || !hbForm.schedule.trim() || !hbForm.prompt.trim()">
              {{ heartbeat ? "Save heartbeat" : "Set heartbeat" }}
            </button>
            <button v-if="heartbeat" class="secondary" type="button" @click="hbForm.open = false"><X :size="16" />Cancel</button>
          </div>
          <p class="prime-meta">A session has one heartbeat; saving replaces it. {{ SCHEDULE_HELP }}</p>
        </form>
      </article>

      <!-- schedules -->
      <article class="ext-card prime-card" data-prime="schedules">
        <div class="ext-head">
          <div>
            <strong><CalendarClock :size="16" /> Schedules</strong>
            <span class="tag">{{ schedules.length }}</span>
          </div>
          <button v-if="schedForm.editing !== 'new'" class="secondary" :disabled="!!pending" @click="openSchedForm()"><Plus :size="16" />Add</button>
        </div>
        <p v-if="note" class="prime-meta" role="status" data-prime="edit-note">{{ note }}</p>
        <p v-if="!schedules.length && schedForm.editing !== 'new'" class="task-empty">No schedules.</p>
        <ul class="prime-list">
          <li v-for="job in schedules" :key="job.id" :data-prime-job="job.id">
            <div class="prime-job-head">
              <code>{{ job.schedule }}</code>
              <span v-if="job.status === 'paused'" class="tag">Paused</span>
              <small title="Prime's job id. Editing cancels the job and adds a new one, so the id changes.">{{ job.id }}</small>
            </div>
            <p class="prime-text">{{ job.prompt }}</p>
            <p class="prime-meta">
              <template v-if="job.nextRunAt">Next {{ when(job.nextRunAt) }}</template>
              <template v-if="job.runCount"> · {{ job.runCount }} run{{ job.runCount === 1 ? "" : "s" }}</template>
            </p>
            <div v-if="schedForm.editing !== job.id" class="prime-actions">
              <button class="secondary" :disabled="!!pending" @click="openSchedForm(job)"><Pencil :size="16" />Edit</button>
              <button class="secondary danger" :disabled="!!pending" @click="cancelSchedule(job)"><Trash2 :size="16" />Cancel</button>
            </div>
          </li>
        </ul>
        <form v-if="schedForm.editing" class="prime-form" data-prime="schedule-form" @submit.prevent="saveSchedule">
          <label class="field-label" for="prime-sched-schedule">{{ schedForm.editing === "new" ? "New schedule" : "Edit schedule" }}</label>
          <input id="prime-sched-schedule" v-model="schedForm.schedule" placeholder="in 30m" />
          <label class="field-label" for="prime-sched-prompt">Prompt</label>
          <textarea id="prime-sched-prompt" v-model="schedForm.prompt" rows="3" placeholder="What to send when it fires" />
          <div class="prime-actions">
            <button class="primary small" type="submit" :disabled="!!pending || !schedForm.schedule.trim() || !schedForm.prompt.trim()">
              {{ schedForm.editing === "new" ? "Add schedule" : "Save (new id)" }}
            </button>
            <button class="secondary" type="button" @click="schedForm.editing = ''"><X :size="16" />Cancel</button>
          </div>
          <p class="prime-meta">
            {{ SCHEDULE_HELP }}<template v-if="schedForm.editing !== 'new'"> Prime cannot edit a schedule: saving cancels it and adds a new one with a new id.</template>
          </p>
        </form>
      </article>
    </template>
  </div>
</template>
