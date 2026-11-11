// Prime's own durable work (scheduled prompts, heartbeats, the session goal) as dpi tasks and jobs, for one session.
// Sources: daemon `cron_list` (schedules and heartbeats share one store; `source` tells them apart) and
// `get_connection_state`.goal. Goals are driven through the `/goal` slash command sent as a prompt: the worker runs it
// as a session command (crates/pa-core/src/session_engine/session_commands.rs), there is no daemon command for it.
import { readFileSync, writeFileSync } from "node:fs";
import type { TaskNode, TaskOutcome } from "../../../dpi-sdk/src/api.js";
import type { JobDef, JobInputValue, JobRun, JobRunsDoc } from "../../../dpi-sdk/src/jobs.js";
import { ApiFault, invalid, notFound } from "../errors.js";
import { PrimeError } from "./client.js";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Outcome = NonNullable<TaskOutcome["state"]["outcome"]>;

export interface Daemon {
  request(command: { type: string; [k: string]: unknown }): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  on(event: string, fn: (...args: any[]) => void): unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
  off(event: string, fn: (...args: any[]) => void): unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface TasksOptions {
  /** Persists the string-id -> number mapping (JSON). Without it ids restart at 1 with the backend. */
  idFile?: string;
  /** Poll interval while someone listens (default 5000): cron changes have no daemon event. */
  pollMs?: number;
}

export type TaskKind = "prime.schedule" | "prime.heartbeat" | "prime.goal";

/** One Prime schedule/heartbeat/goal, normalised; the TaskNode / TaskOutcome / JobRun views are derived from it. */
export interface Item {
  key: string;
  kind: TaskKind;
  /** Prime's own id: the cron job id, or the goal id. */
  ref: string;
  label: string;
  live: boolean;
  phase: string;
  outcome?: Outcome;
  /** ms since epoch of the last change, for ordering. */
  at: number;
}

const head = (s: string, n = 60) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const ms = (iso: unknown) => (typeof iso === "string" && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : 0);

/** A cron_list job (AgentCronJob, crates/pa-core/src/cron/mod.rs). */
export function cronItem(job: J): Item {
  const heartbeat = job.source === "heartbeat" || job.source === "rlm_heartbeat";
  const expr = String(job.schedule?.expression ?? "");
  const live = job.status === "active" || job.status === "paused";
  const what = job.label ? String(job.label) : head(String(job.prompt ?? ""));
  const result = { id: job.id, schedule: expr, prompt: job.prompt, runCount: job.runCount ?? 0, lastRunAt: job.lastRunAt };
  let outcome: Outcome | undefined;
  if (job.status === "cancelled") outcome = { status: "aborted", result };
  else if (job.status === "completed")
    outcome = job.lastError ? { status: "failed", result, error: { message: String(job.lastError) } } : { status: "completed", result };
  return {
    key: `cron:${job.id}`,
    kind: heartbeat ? "prime.heartbeat" : "prime.schedule",
    ref: String(job.id),
    label: `${heartbeat ? "Heartbeat " : ""}${expr}: ${what}`,
    live,
    phase: job.status === "paused" ? "paused" : job.nextRunAt ? `next ${job.nextRunAt}` : "scheduled",
    outcome,
    at: ms(job.updatedAt),
  };
}

/** A GoalState (crates/pa-types/src/goal.rs); undefined when the session has no goal. */
export function goalItem(goal: J | null | undefined): Item | undefined {
  if (!goal?.objective || goal.status === "idle") return undefined;
  const live = goal.status === "active" || goal.status === "paused";
  const result = { objective: goal.objective, tokensUsed: goal.tokensUsed, tokenBudget: goal.tokenBudget, timeUsedSeconds: goal.timeUsedSeconds, continuationsUsed: goal.continuationsUsed };
  let outcome: Outcome | undefined;
  if (goal.status === "complete") outcome = { status: "completed", result };
  else if (goal.status === "budget_limited") outcome = { status: "aborted", result: { ...result, reason: "token budget reached" } };
  else if (goal.status === "error") outcome = { status: "failed", result, error: { message: String(goal.lastError ?? goal.lastReason ?? "goal failed") } };
  const ref = String(goal.goalId ?? "current");
  return { key: `goal:${ref}`, kind: "prime.goal", ref, label: head(String(goal.objective)), live, phase: String(goal.status), outcome, at: Number(goal.updatedAt) || 0 };
}

/** Live items are background tasks of the main conversation (1); a schedule between fires is "waiting", an active goal "running". */
export const taskNode = (id: number, it: Item): TaskNode => ({
  id,
  kind: it.kind,
  conversationId: 1,
  background: true,
  state: { status: it.kind === "prime.goal" && it.phase === "active" ? "running" : "waiting", phase: it.phase },
  conversations: [],
  label: it.label,
});

export const taskOutcome = (id: number, it: Item): TaskOutcome => ({
  id,
  kind: it.kind,
  conversationId: 1,
  state: { status: "terminal", outcome: it.outcome },
});

// ------------------------------------------------------------------ the jobs the Tasks tab can start

const phase = (id: string, label: string, summary: string) => ({ id, label, summary });
const text = (name: string, description: string, dflt: string) => ({ name, type: "string" as const, description, default: dflt });
const SCHEDULE_HELP = 'Prime schedule text: "in 30m" (once), "every 1h", "at 2026-12-01T09:00:00Z" (once) or a 5-field cron expression.';

export const JOB_DEFS: JobDef[] = [
  {
    id: "prime.schedule",
    title: "Schedule a prompt",
    summary: "Sends a prompt to this session on a schedule.",
    phases: [phase("scheduled", "Scheduled", "Waits for its next fire time; each fire sends the prompt.")],
    inputs: [text("schedule", SCHEDULE_HELP, "in 1h"), text("prompt", "What to send to the session when it fires.", "Check in on the current work and report briefly.")],
    approval: false,
    resultPath: "prime/schedule",
    seconds: 1,
  },
  {
    id: "prime.heartbeat",
    title: "Heartbeat",
    summary: "Replaces this session's heartbeat: a recurring nudge delivered while the session is busy or idle.",
    phases: [phase("beating", "Beating", "Fires on its interval until paused or stopped.")],
    inputs: [text("schedule", SCHEDULE_HELP, "every 1h"), text("prompt", "The heartbeat instruction.", "Check progress and continue the current work.")],
    approval: false,
    resultPath: "prime/heartbeat",
    seconds: 1,
  },
  {
    id: "prime.goal",
    title: "Set a goal",
    summary: "Gives this session an objective it keeps working toward across turns, optionally within a token budget. Starts a turn immediately.",
    phases: [phase("working", "Working", "Continues turn after turn until the goal completes, errors, runs out of budget or is stopped.")],
    inputs: [
      text("objective", "What the session should achieve (required).", ""),
      { name: "tokenBudget", type: "integer", description: "Stop after this many tokens; 0 means no budget.", default: 0, min: 0 },
    ],
    approval: false,
    resultPath: "prime/goal",
    seconds: 60,
  },
];

function coerce(def: JobDef, input: Record<string, unknown>): Record<string, JobInputValue> {
  const out: Record<string, JobInputValue> = {};
  for (const spec of def.inputs) {
    let v = input[spec.name] ?? spec.default;
    if (spec.type === "integer") {
      v = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      if (typeof v !== "number" || !Number.isInteger(v)) throw invalid(`${spec.name} must be an integer`);
      if ((spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max)) throw invalid(`${spec.name} is out of range`);
    } else {
      if (typeof v !== "string") throw invalid(`${spec.name} must be a string`);
      v = v.trim();
      if (!v) throw invalid(`${spec.name} is required`);
    }
    out[spec.name] = v as JobInputValue;
  }
  return out;
}

// ------------------------------------------------------------------ the per-session service

export class PrimeTasks {
  private next = 1;
  private ids: Record<string, number> = {};
  private items = new Map<number, Item>(); // as of the last refresh
  private cleared = new Map<string, Item>(); // goals stopped through abort(): Prime forgets a cleared goal
  private runs = new Map<number, JobRun>();
  private counts: Record<string, number> = {};
  private listeners = new Set<() => void>();
  private sig?: string;
  private timer?: NodeJS.Timeout;
  private stop?: () => void;

  constructor(
    private readonly client: Daemon,
    private readonly session: string | (() => string),
    private readonly opts: TasksOptions = {},
  ) {
    if (opts.idFile) {
      try {
        const saved = JSON.parse(readFileSync(opts.idFile, "utf8"));
        this.ids = saved.ids ?? {};
        this.next = saved.next ?? 1;
      } catch {
        // no file yet, or unreadable: start fresh
      }
    }
  }

  private get sid() {
    return typeof this.session === "function" ? this.session() : this.session;
  }

  private async req(command: { type: string; [k: string]: unknown }) {
    try {
      return await this.client.request({ ...command, activeSessionId: this.sid });
    } catch (e) {
      if (e instanceof PrimeError) throw new ApiFault(e.transport ? "unavailable" : "invalid", e.message);
      throw e;
    }
  }

  private idOf(key: string): number {
    if (this.ids[key] === undefined) {
      this.ids[key] = this.next++;
      if (this.opts.idFile) writeFileSync(this.opts.idFile, JSON.stringify({ next: this.next, ids: this.ids }));
    }
    return this.ids[key];
  }

  /** Reads Prime's state, rebuilds the task views and the run records, and notifies listeners if anything changed. */
  async refresh(): Promise<void> {
    const [cron, state] = await Promise.all([this.req({ type: "cron_list", includeInactive: true }), this.req({ type: "get_connection_state" })]);
    const found = [...(cron?.jobs ?? []).map(cronItem), goalItem(state?.goal)].filter((i): i is Item => !!i);
    for (const [key, it] of this.cleared) if (!found.some((f) => f.key === key)) found.push(it);
    this.items = new Map(found.map((it) => [this.idOf(it.key), it]));
    for (const [id, run] of this.runs) {
      const it = this.items.get(id);
      if (it) this.syncRun(run, it);
    }
    const sig = JSON.stringify([...this.items].map(([id, it]) => [id, it.live, it.phase, it.outcome?.status]));
    if (sig === this.sig) return;
    this.sig = sig;
    for (const l of this.listeners) l();
  }

  /** TaskNode per live schedule / heartbeat / goal. */
  async liveTasks(): Promise<TaskNode[]> {
    await this.refresh();
    return [...this.items].filter(([, it]) => it.live).map(([id, it]) => taskNode(id, it)).sort((a, b) => a.id - b.id);
  }

  /** Oldest first, the newest `limit` (the Tasks tab takes the tail). */
  async terminalTasks(limit = 40): Promise<TaskOutcome[]> {
    await this.refresh();
    return [...this.items]
      .filter(([, it]) => !it.live && it.outcome)
      .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
      .slice(-Math.max(0, limit))
      .map(([id, it]) => taskOutcome(id, it));
  }

  /** Cancels the schedule, stops the heartbeat, or clears the goal. */
  async abort(taskId: number): Promise<void> {
    if (!this.items.get(taskId)?.live) await this.refresh();
    const it = this.items.get(taskId);
    if (!it) throw notFound(`No Prime task ${taskId}`);
    if (!it.live) throw new ApiFault("conflict", `Task ${taskId} already finished`);
    if (it.kind === "prime.schedule") await this.req({ type: "cron_cancel", jobId: it.ref });
    else if (it.kind === "prime.heartbeat") await this.req({ type: "heartbeat_manage", jobId: it.ref, action: "stop" });
    else {
      await this.req({ type: "prompt", message: "/goal clear" });
      this.cleared.set(it.key, { ...it, live: false, at: Date.now(), outcome: { status: "aborted", result: { objective: it.label } } });
    }
    await this.refresh();
  }

  jobDefs(): JobDef[] {
    return JOB_DEFS;
  }

  /** Creates the schedule / heartbeat / goal on the session and returns its task id. Missing inputs take the JobDef defaults. */
  async runJob(job: string, input: Record<string, unknown> = {}): Promise<{ taskId: number }> {
    const def = JOB_DEFS.find((d) => d.id === job);
    if (!def) throw notFound(`No Prime job "${job}"`);
    const v = coerce(def, input);
    let key: string;
    if (job === "prime.schedule") {
      key = `cron:${(await this.req({ type: "cron_add", schedule: v.schedule, prompt: v.prompt })).job.id}`;
    } else if (job === "prime.heartbeat") {
      key = `cron:${(await this.req({ type: "heartbeat_set", schedule: v.schedule, prompt: v.prompt })).heartbeat.id}`;
    } else {
      const budget = Number(v.tokenBudget);
      await this.req({ type: "prompt", message: `/goal ${budget > 0 ? `--budget ${budget} ` : ""}${v.objective}` });
      await this.refresh();
      const live = [...this.items.values()].find((i) => i.kind === "prime.goal" && i.live);
      if (!live) throw new ApiFault("internal", "Prime did not start the goal");
      key = live.key;
    }
    if (job !== "prime.goal") await this.refresh();
    const taskId = this.idOf(key);
    const it = this.items.get(taskId);
    const now = Date.now();
    const n = (this.counts[job] = (this.counts[job] ?? 0) + 1);
    const run: JobRun = {
      id: taskId,
      job,
      title: def.title,
      run: n,
      input: v,
      startedBy: "you",
      background: true,
      status: "running",
      phase: def.phases[0].id,
      phases: [{ id: def.phases[0].id, label: def.phases[0].label, status: "running", startedAt: now, steps: [] }],
      resumed: 0,
      startedAt: now,
      updatedAt: now,
    };
    if (it) this.syncRun(run, it);
    this.runs.set(taskId, run);
    return { taskId };
  }

  private syncRun(run: JobRun, it: Item) {
    const before = run.status;
    if (it.live) {
      run.status = it.kind === "prime.goal" && it.phase === "active" ? "running" : "waiting";
      run.phases[0].status = run.status;
    } else if (it.outcome) {
      run.status = it.outcome.status === "completed" ? "completed" : it.outcome.status === "failed" ? "failed" : "aborted";
      run.phases[0].status = run.status === "completed" ? "done" : run.status === "failed" ? "failed" : "aborted";
      run.endedAt ??= it.at || Date.now();
      run.phases[0].endedAt = run.endedAt;
      run.result = it.label;
      if (it.outcome.error) run.error = it.outcome.error.message;
    }
    if (run.status !== before) run.updatedAt = Date.now();
  }

  /** The `demo.job-runs` document: one run record per job started through runJob since the backend started. */
  jobRunsDoc(): JobRunsDoc {
    return { counts: { ...this.counts }, items: Object.fromEntries([...this.runs].map(([id, r]) => [String(id), r])) };
  }

  /** Fires when the set of tasks or any task's phase/outcome changes. Driven by `heartbeats_changed`, `goal_update`, and a poll. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    if (!this.stop) {
      const poke = () => void this.refresh().catch(() => {}); // a failed read keeps the last good view
      const onFrame = (f: J) => f?.type === "heartbeats_changed" && poke();
      const onEvent = (f: J) => f?.activeSessionId === this.sid && f.event?.type === "goal_update" && poke();
      this.client.on("frame", onFrame);
      this.client.on("session_event", onEvent);
      this.timer = setInterval(poke, this.opts.pollMs ?? 5000);
      this.timer.unref();
      this.stop = () => {
        this.client.off("frame", onFrame);
        this.client.off("session_event", onEvent);
        clearInterval(this.timer);
        this.stop = undefined;
      };
      poke();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stop?.();
    };
  }

  close() {
    this.listeners.clear();
    this.stop?.();
  }
}
