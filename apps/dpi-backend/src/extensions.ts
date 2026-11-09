import type { SharedState } from "./shared-state.js";
import { Type } from "@earendil-works/pi-ai";
import { isAbsolute, resolve, join } from "node:path";
import { homedir, hostname, tmpdir } from "node:os";
import { execFile, spawn as spawnProcess } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm, stat } from "node:fs/promises";
import { readState, type AppState } from "../../dpi-sdk/src/app-state.js";
import type { SessionSummary, ThinkingLevel } from "../../dpi-sdk/src/api.js";
import { THINKING_LEVELS } from "../../dpi-sdk/src/api.js";
import type { WireEntry } from "../../dpi-sdk/src/api.js";
import { jobRunDone, type JobRun } from "../../dpi-sdk/src/jobs.js";
import {
  defineDoc,
  defineTool,
  defineExtension,
  section,
  configure,
  AssistantEntry,
  type EntryRecord,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { JobRuns, jobDef, resolveJobInput, type Jobs } from "./jobs.js";
import { searchHistory } from "./history.js";

export const Workspace = defineDoc<AppState>({
  kind: "demo.workspace",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ goal: "Explore durable agents", counter: 0, notes: [] }),
});
const Receipt = defineDoc<{ applied: boolean; result: string }>({
  kind: "demo.receipt",
  version: 1,
  scope: "task",
  initial: () => ({ applied: false, result: "" }),
});
/** The last page ping_on_call_engineer sent from this conversation. */
const Pager = defineDoc<{ paged: boolean; at: number; page: string; summary: string }>({
  kind: "demo.pager",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ paged: false, at: 0, page: "", summary: "" }),
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How many subagents one codemode script may run at once; further `tools.subagent()` calls wait for a slot. */
export const MAX_SCRIPT_SUBAGENTS = 8;

/**
 * Process-local counting semaphores, one per `<conversation>:<script call>`. A restart resets them, which is fine: the
 * subagent tool is replay-safe and reattaches to the child it already created, so a rerun never spawns a second one.
 */
const scriptSubagentSlots = new Map<string, { active: number; waiters: (() => void)[] }>();
async function acquireScriptSubagentSlot(key: string, signal?: AbortSignal): Promise<() => void> {
  let slots = scriptSubagentSlots.get(key);
  if (!slots) scriptSubagentSlots.set(key, (slots = { active: 0, waiters: [] }));
  if (slots.active >= MAX_SCRIPT_SUBAGENTS) {
    const mine = slots;
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", cancel);
        resolve();
      };
      const cancel = () => {
        const i = mine.waiters.indexOf(wake);
        if (i >= 0) mine.waiters.splice(i, 1);
        reject(signal?.reason ?? Error("aborted"));
      };
      if (signal?.aborted) return cancel();
      signal?.addEventListener("abort", cancel, { once: true });
      mine.waiters.push(wake);
    });
  }
  slots.active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    slots.active--;
    const next = slots.waiters.shift();
    if (next) next();
    else if (slots.active === 0) scriptSubagentSlots.delete(key);
  };
}

/** One line per phase change, for the run_durable_job call's live output. */
function progressLines(run: JobRun) {
  return run.phases.flatMap((phase, i) => {
    const n = `${i + 1}/${run.phases.length} ${phase.label}`;
    if (phase.status === "done") return [`✓ ${n}: ${phase.summary ?? "done"}`];
    if (phase.status === "running") return [`▸ ${n}`];
    if (phase.status === "waiting") return [`⏸ ${n}: waiting for a person to approve in the chat`];
    if (phase.status === "failed" || phase.status === "aborted") return [`✗ ${n}: ${phase.summary ?? phase.status}`];
    return [];
  });
}

const phaseLabel = (run: JobRun) => run.phases.find((p) => p.id === run.phase)?.label;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One run as check_durable_job reports it: compact enough for a model, complete enough to act on. */
function runReport(run: JobRun, now: number) {
  return {
    taskId: run.id,
    job: run.job,
    title: run.title,
    run: run.run,
    status: run.status,
    ...(jobRunDone(run) ? {} : { phase: phaseLabel(run) }),
    ...(run.approval === "pending" ? { next: "Waiting for a person to approve in the chat" } : {}),
    ...(run.approval && run.approval !== "pending" ? { approval: run.approval } : {}),
    startedBy: run.startedBy,
    background: run.background,
    seconds: Math.round(((run.endedAt ?? now) - run.startedAt) / 100) / 10,
    ...(run.resumed ? { resumedAfterRestart: run.resumed } : {}),
    ...(run.result ? { result: run.result } : {}),
    ...(run.error ? { error: run.error } : {}),
    phases: run.phases.map((p) => ({
      phase: p.label,
      status: p.status,
      ...(p.summary ? { summary: p.summary } : {}),
      ...(p.progress ? { progress: `${p.progress.done}/${p.progress.total}` } : {}),
      ...(p.steps.length
        ? { steps: p.steps.map((s) => `${s.status} ${s.kind} ${s.label}${s.detail ? `: ${clip(s.detail.replace(/\s+/g, " "), 160)}` : ""}`) }
        : {}),
    })),
  };
}

/** Creates a session on this device, exactly once per `key`, and optionally sends its first prompt. */
export type SpawnSession = (input: {
  key: string;
  name: string;
  cwd: string;
  model: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  prompt?: string;
}) => Promise<{ session: SessionSummary; submissionId?: number }>;

export type ValidateModel = (model: { provider: string; modelId: string }) => { provider: string; modelId: string };

/**
 * Sends a page through dpi-page on pi-big (Hermes relays it verbatim; hermex-push puts it on Sab's phone).
 * DPI_PAGER overrides the command (tests); it gets the same --severity/--from args and the message on stdin.
 */
function sendPage(severity: string, from: string, message: string): Promise<{ ok: boolean; detail: string }> {
  const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  const [cmd, argv] = process.env.DPI_PAGER
    ? [process.env.DPI_PAGER, ["--severity", severity, "--from", from]]
    : ["ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "big", `dpi-page --severity ${q(severity)} --from ${q(from)}`]];
  return new Promise((done) => {
    const child = spawnProcess(cmd, argv, { stdio: ["pipe", "pipe", "pipe"], timeout: 180_000 });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => done({ ok: false, detail: e.message }));
    child.on("close", (code, signal) => {
      const sid = out.trim().split("\n").pop() ?? "";
      if (code === 0 && sid) done({ ok: true, detail: sid });
      else done({ ok: false, detail: `${cmd} exited ${signal ?? code}: ${(err || out).trim().slice(-400)}` });
    });
    child.stdin.end(message);
  });
}

export function createPlayground(
  shared: SharedState,
  sessionId: string,
  spawn: SpawnSession,
  jobs: Jobs,
  validateModel?: ValidateModel,
) {
  const readAppState = defineTool({
    name: "read_state",
    description:
      "Read the shared App State object used by every session, conversation and fork, or a field at a JSON Pointer path. Empty path reads the whole object.",
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    replay: "safe",
    execute: async (args) => {
      const { value } = await shared.snapshot();
      return {
        output: [{ type: "text", text: JSON.stringify(readState(value, args.path ?? "")) }],
      };
    },
  });
  const updateState = defineTool({
    name: "update_state",
    description:
      'CRUD the shared App State used by every agent and fork on this device. create adds a new field, update replaces an existing value, delete removes it, increment adds a signed number. value_json must be JSON-encoded text: 3 for a number, true for a boolean, "hello" (including quotes) for a string, {"enabled":true} for an object, or [1,2] for an array. Omit value_json for delete. Use JSON Pointer paths: /counter, /settings/enabled, /notes/- to append. Escape ~ as ~0 and / as ~1. Empty path with update replaces the whole root object, with delete clears it. Read first with read_state. UI controls update live. Changes are atomic and replay-safe.',
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("create"),
        Type.Literal("update"),
        Type.Literal("delete"),
        Type.Literal("increment"),
      ]),
      path: Type.String(),
      value_json: Type.Optional(
        Type.String({
          description:
            "JSON-encoded value. Objects and arrays must be encoded as JSON here, not passed as native tool argument objects.",
        }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const next = await shared.change(
        {
          operation: args.operation,
          path: args.path,
          value: args.value_json === undefined ? undefined : JSON.parse(args.value_json),
        },
        `agent:${sessionId}:${api.taskId}`,
      );
      const value = await api.commit(async (tx) => {
        const receipt = await tx.doc(Receipt, api.taskId);
        if (!receipt.applied) {
          await tx.appendEntry(api.conversationId, {
            kind: "demo.state-change",
            data: { taskId: api.taskId, text: `App State: ${args.operation} ${args.path || "/"}` },
          });
          receipt.applied = true;
          receipt.result = JSON.stringify(next);
        }
        return receipt.result;
      }, ctx);
      return { output: [{ type: "text", text: value }] };
    },
  });
  const recentRuns = async (api: Pick<ToolExecutionApi, "conversationId" | "snapshot">, ctx: Context) =>
    Object.values((await api.snapshot(JobRuns, api.conversationId, ctx))?.items ?? {}).sort((a, b) => b.id - a.id);
  const listJobs = defineTool({
    name: "list_durable_jobs",
    description:
      "List the durable jobs you can start with run_durable_job: each job's id, what it does, its named phases, the inputs it takes (type, default, limits), whether it waits for a person's approval, the App State path where every run saves its result, and its recent runs in this conversation with their task ids for check_durable_job.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, ctx) => {
      const runs = await recentRuns(api, ctx);
      return {
        output: [
          {
            type: "text",
            text: JSON.stringify(
              jobs.defs.map((d) => ({
                job: d.id,
                title: d.title,
                summary: d.summary,
                phases: d.phases.map((p) => `${p.label}: ${p.summary}`),
                inputs: Object.fromEntries(
                  d.inputs.map((i) => [
                    i.name,
                    { type: i.type, default: i.default, ...(i.min !== undefined ? { min: i.min, max: i.max } : {}), description: i.description },
                  ]),
                ),
                needsApproval: d.approval,
                savesTo: d.resultPath,
                typicalSeconds: d.seconds,
                recentRuns: runs
                  .filter((r) => r.job === d.id)
                  .slice(0, 5)
                  .map((r) => ({ taskId: r.id, run: r.run, status: r.status, phase: phaseLabel(r) })),
              })),
            ),
          },
        ],
      };
    },
  });
  const runJob = defineTool({
    name: "run_durable_job",
    description:
      'Start a durable job: a repeatable workflow with named phases that runs as one checkpointed task and is recorded in the conversation. Call list_durable_jobs first for ids and inputs. It runs in the background: you get its task id at once, the conversation owns the run, and you check it with check_durable_job. Set wait true only when you need the result before continuing; then the call owns the run, an interrupt stops it, and you get the outcome of every phase. Example: {"job":"workspace-snapshot","input":{"path":"."}}.',
    parameters: Type.Object({
      job: Type.String({ description: "Job id from list_durable_jobs." }),
      input: Type.Optional(
        Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]), {
          description: "The job's inputs by name. Omitted inputs use their defaults.",
        }),
      ),
      wait: Type.Optional(
        Type.Boolean({ description: "Wait for the run to finish, including any approval. Default false." }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const def = jobDef(args.job);
      if (!def) throw Error(`Unknown job ${args.job}. Jobs: ${jobs.defs.map((d) => d.id).join(", ")}`);
      const input = resolveJobInput(def, args.input ?? {});
      const wait = args.wait === true;
      // A replay after a crash finds the run this call started instead of starting another.
      const taskId = await api.commit(async (tx) => {
        const receipt = await tx.doc(Receipt, api.taskId);
        if (receipt.applied) return Number(receipt.result);
        const id = await jobs.start(tx, api.conversationId, {
          def,
          input,
          startedBy: "agent",
          toolCallId: api.callId,
          ...(wait ? { owner: api.taskId } : {}),
          now: Date.now(),
        });
        receipt.applied = true;
        receipt.result = String(id);
        return id as number;
      }, ctx);
      await api.details({ taskId, job: def.id }, ctx);
      const read = async () => (await api.snapshot(JobRuns, api.conversationId, ctx))?.items[String(taskId)];
      if (!wait) {
        const run = await read();
        return {
          output: [
            {
              type: "text",
              text: `Started ${def.title} run #${run?.run ?? "?"} as durable task #${taskId}. It runs in the background, shows live in the chat and saves its result to App State ${def.resultPath}. Check it with check_durable_job {"task_id":${taskId}}.`,
            },
          ],
          details: { taskId, job: def.id },
        };
      }
      const printed = new Set<string>();
      let run = await read();
      for (;;) {
        for (const line of run ? progressLines(run) : [])
          if (!printed.has(line)) {
            printed.add(line);
            api.output(`${line}\n`);
          }
        if (!run || jobRunDone(run)) break;
        await pause(400);
        run = await read();
      }
      const ok = run?.status === "completed";
      return {
        output: [
          {
            type: "text",
            text: run
              ? `${def.title} run #${run.run} ${run.status}${ok ? `: ${run.result}` : run.error ? `: ${run.error}` : ""}.\n${progressLines(run).join("\n")}${ok ? `\nResult saved to App State ${def.resultPath}.` : ""}`
              : `${def.title} task #${taskId} has no record.`,
          },
        ],
        isError: !ok,
        details: { taskId, job: def.id },
      };
    },
  });
  const checkJob = defineTool({
    name: "check_durable_job",
    description:
      "Check durable job runs in this conversation. With task_id, one run in full: status, current phase, every phase's outcome and steps (commands, the subagent's tool calls, App State writes), approval, result or error. With job, that job's latest run. With neither, a short list of recent runs. Task ids come from run_durable_job and list_durable_jobs.",
    parameters: Type.Object({
      task_id: Type.Optional(Type.Integer({ minimum: 1, description: "The run's task id." })),
      job: Type.Optional(Type.String({ description: "A job id: check its latest run." })),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const runs = await recentRuns(api, ctx);
      const run =
        args.task_id !== undefined
          ? runs.find((r) => r.id === args.task_id)
          : args.job !== undefined
            ? runs.find((r) => r.job === args.job)
            : undefined;
      if (args.task_id === undefined && args.job === undefined)
        return {
          output: [
            {
              type: "text",
              text: JSON.stringify(
                runs.slice(0, 10).map((r) => ({ taskId: r.id, job: r.job, run: r.run, status: r.status, phase: phaseLabel(r) })),
              ),
            },
          ],
        };
      if (!run)
        throw Error(
          `No run ${args.task_id !== undefined ? `with task id ${args.task_id}` : `of ${args.job}`} in this conversation. Runs: ${runs.map((r) => `${r.id} (${r.job} #${r.run})`).join(", ") || "none"}`,
        );
      return { output: [{ type: "text", text: JSON.stringify(runReport(run, Date.now())) }] };
    },
  });
  const searchHistoryTool = defineTool({
    name: "search_history",
    description:
      "Search your own full stored history, including entries from before a reset, handoff or compaction that you can no longer see. Filter by words (query), by tool name (tool), by entry kind, or by entry number range (from_entry, to_entry). Pass entry to read one entry in full by its number. Results come newest first (order oldest to reverse) and are paged with limit and offset; use next_offset for the next page. Each result says whether the entry is active, compacted or before reset.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Words that must all appear, case-insensitive." })),
      tool: Type.Optional(Type.String({ description: "Only calls to and results from this tool, for example bash." })),
      entry: Type.Optional(Type.Integer({ minimum: 1, description: "Read this one entry in full." })),
      kind: Type.Optional(
        Type.Union([
          Type.Literal("user"),
          Type.Literal("assistant"),
          Type.Literal("tool_call"),
          Type.Literal("tool_result"),
          Type.Literal("event"),
        ]),
      ),
      from_entry: Type.Optional(Type.Integer({ minimum: 1, description: "Oldest entry number to include." })),
      to_entry: Type.Optional(Type.Integer({ minimum: 1, description: "Newest entry number to include." })),
      order: Type.Optional(Type.Union([Type.Literal("newest"), Type.Literal("oldest")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Results per page. Default 10." })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Results to skip. Default 0." })),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const { entries, activeFrom } = await api.commit(async (tx) => {
        const all: EntryRecord[] = [];
        let page = await tx.scanEntries({ conversationId: api.conversationId }, 500);
        all.push(...page.items);
        while (page.next && all.length < 10_000) {
          page = await tx.scanEntries({ conversationId: api.conversationId }, 500, page.next);
          all.push(...page.items);
        }
        return { entries: all, activeFrom: (await tx.latestHeadMarker(api.conversationId))?.head as number | undefined };
      }, ctx);
      const resets = entries.filter((e) => e.kind === "pi.reset").map((e) => e.id as number);
      const result = searchHistory(entries as unknown as WireEntry[], args, {
        activeFrom,
        lastReset: resets.length ? Math.max(...resets) : undefined,
      });
      return { output: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
  // No replay policy: the default `unsafe` means a crash mid-call returns an interrupted result and never pages twice.
  const pingOnCall = defineTool({
    name: "ping_on_call_engineer",
    description:
      "Page Sab on his phone when something needs his decision or is broken and you cannot proceed. Your summary is relayed verbatim through Hermes to the Hermex app; the result says whether it was delivered.",
    parameters: Type.Object({
      summary: Type.String({ description: "What Sab needs to know and what you need from him, in a few sentences." }),
      severity: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("high"), Type.Literal("critical")])),
    }),
    execute: async (args, api, ctx) => {
      const severity = args.severity ?? "high";
      const page = `PG-${String(api.taskId).padStart(4, "0")}`;
      await api.commit(async (tx) => {
        const pager = await tx.doc(Pager, api.conversationId);
        Object.assign(pager, { paged: true, at: Date.now(), page, summary: args.summary.slice(0, 300) });
      }, ctx);
      const from = `${hostname()} session ${sessionId}, conversation ${api.conversationId}, ${page}`;
      const sent = await sendPage(severity, from, args.summary);
      const text = sent.ok
        ? `Delivered ${page} (${severity}) to Sab's phone as Hermes session ${sent.detail}. He has not necessarily read it yet.`
        : `NOT delivered: ${page} (${severity}) failed to reach Sab: ${sent.detail}`;
      api.output(`${text}\n`);
      return { output: [{ type: "text", text }] };
    },
  });
  const subagent = defineTool({
    name: "subagent",
    description:
      `Delegate a self-contained task to an owned child conversation. Parent interruption also interrupts the child. A codemode script runs at most ${MAX_SCRIPT_SUBAGENTS} subagents at once; further calls wait for a slot.`,
    parameters: Type.Object({
      task: Type.String(),
      model: Type.Optional(
        Type.String({
          description:
            "Model for the child: a model id from this device model list, or provider/modelId. Default: your current model.",
        }),
      ),
      thinkingLevel: Type.Optional(
        Type.String({ description: `Reasoning level for the child: ${THINKING_LEVELS.join(", ")}. Default: yours.` }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const parent = await api.agent(ctx);
      let model: { provider: string; modelId: string } | undefined;
      if (args.model) {
        if (!validateModel) throw Error("Choosing a subagent model is not available here");
        const candidates: { provider: string; modelId: string }[] = [];
        if (parent.model) candidates.push({ provider: parent.model.provider, modelId: args.model });
        const slash = args.model.indexOf("/");
        if (slash > 0) candidates.push({ provider: args.model.slice(0, slash), modelId: args.model.slice(slash + 1) });
        let lastError: unknown;
        for (const c of candidates) {
          try {
            model = validateModel(c);
            break;
          } catch (e) {
            lastError = e;
          }
        }
        if (!model) throw lastError instanceof Error ? lastError : Error(`Unknown model ${args.model}`);
      }
      const thinkingLevel = args.thinkingLevel
        ? THINKING_LEVELS.find((level) => level === args.thinkingLevel)
        : undefined;
      if (args.thinkingLevel && !thinkingLevel)
        throw Error(`Invalid thinkingLevel ${args.thinkingLevel}. Use one of: ${THINKING_LEVELS.join(", ")}`);
      // A nested call (`<script call id>/c<n>`) takes one of its script's slots; model-issued calls are not capped.
      const slash = api.callId.lastIndexOf("/");
      const release =
        slash > 0
          ? await acquireScriptSubagentSlot(`${api.conversationId}:${api.callId.slice(0, slash)}`, ctx.abortSignal)
          : () => {};
      try {
        const id = await api.commit(async (tx) => {
          const found = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
          if (found) return found.id;
          const child = await tx.createConversation({
            ownership: { kind: "task", taskId: api.taskId },
          });
          await configure(tx, child.id, {
            tools: { remove: [subagent] },
            ...(model ? { model } : {}),
            ...(thinkingLevel ? { thinkingLevel } : {}),
          });
          return child.id;
        }, ctx);
        await api.details({ conversationId: id }, ctx);
        const child = await api.conversation(id, ctx);
        if (!child) throw Error("Child missing");
        const result = await (
          await child.submit(
            { type: "input", content: args.task, requestId: `child:${api.taskId}` },
            ctx,
          )
        ).wait(ctx);
        const answer =
          result.status === "done" && result.type === "input"
            ? await api.commit((tx) => tx.entry(AssistantEntry, result.answer), ctx)
            : undefined;
        return {
          output: [
            { type: "text", text: answer ? JSON.stringify(answer.model) : JSON.stringify(result) },
          ],
          details: { conversationId: id },
        };
      } finally {
        release();
      }
    },
  });
  const startSession = defineTool({
    name: "start_session",
    description:
      "Start a new session on this device: its own harness, database and working directory, independent of this one. It keeps running if you are interrupted. Returns immediately; you do not wait for it.",
    parameters: Type.Object({
      name: Type.String({ description: "Session name shown in the network tree." }),
      cwd: Type.String({
        description: "Existing folder on this device. Relative paths resolve against your working directory.",
      }),
      model: Type.Optional(
        Type.String({ description: "Model id from this device's model list. Default: your current model." }),
      ),
      prompt: Type.Optional(
        Type.String({ description: "First message for the new session. Default: none, the session starts idle." }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const parent = await api.agent(ctx);
      if (!parent.model) throw Error("This agent has no model to copy");
      const cwd = args.cwd.startsWith("~") || isAbsolute(args.cwd) ? args.cwd : resolve(parent.cwd ?? ".", args.cwd);
      const thinking = THINKING_LEVELS.find((level) => level === parent.thinkingLevel);
      const { session, submissionId } = await spawn({
        key: `start_session:${sessionId}:${api.taskId}`,
        name: args.name,
        cwd,
        model: { provider: parent.model.provider, modelId: args.model ?? parent.model.modelId },
        thinkingLevel: thinking,
        prompt: args.prompt?.trim() || undefined,
      });
      const sent =
        submissionId === undefined
          ? "It has no prompt yet."
          : `Sent its first message as submission #${submissionId}. It runs on its own.`;
      return {
        output: [
          {
            type: "text",
            text: `Started session "${session.name}" (${session.id}) in ${session.cwd} with ${session.model}. ${sent}`,
          },
        ],
        details: { sessionId: session.id, ...(submissionId === undefined ? {} : { submissionId }) },
      };
    },
  });
  // view_image: pi-durable's read tool refuses images, so this returns one as an image block. Large images are
  // downscaled with macOS sips first. Models without "image" in their input get pi-ai's placeholder instead.
  const viewImage = defineTool({
    name: "view_image",
    description:
      "Look at an image file (png, jpg, gif, webp, heic). Use it whenever the user shares a screenshot or image path. Relative paths resolve against your working directory; ~ is expanded. Screenshots synced from sab-air land in ~/dpi-work/inbox.",
    parameters: Type.Object({
      path: Type.String({ description: "Image file path" }),
      max_px: Type.Optional(Type.Number({ description: "Longest side after downscaling. Default 1600, max 2400." })),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const agent = await api.agent(ctx);
      const raw = args.path.startsWith("~") ? join(homedir(), args.path.slice(1)) : args.path;
      const file = isAbsolute(raw) ? raw : resolve(agent.cwd ?? ".", raw);
      const info = await stat(file);
      if (!info.isFile()) throw Error(`${file} is not a file`);
      const max = Math.min(Math.max(Math.round(args.max_px ?? 1600), 256), 2400);
      const out = join(tmpdir(), `dpi-view-${process.pid}-${Date.now()}.jpg`);
      try {
        await promisify(execFile)("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", String(max), file, "--out", out], {
          timeout: 30_000,
        });
        const data = (await readFile(out)).toString("base64");
        return {
          output: [
            { type: "text", text: `${file} (${Math.round(info.size / 1024)} KB, sent as JPEG, longest side <= ${max}px)` },
            { type: "image", data, mimeType: "image/jpeg" },
          ],
        };
      } finally {
        await rm(out, { force: true });
      }
    },
  });
  const handoff = defineTool({
    name: "handoff",
    callers: ["model"],
    description:
      "Start a fresh model context with a concise handoff note. Old transcript stays stored.",
    parameters: Type.Object({ note: Type.String() }),
    execute: async (args) => ({
      output: [{ type: "text", text: "Context handed off." }],
      control: { handoff: args.note },
    }),
  });
  return defineExtension({
    name: "playground",
    tasks: jobs.tasks,
    tools: [
      readAppState,
      updateState,
      listJobs,
      runJob,
      checkJob,
      searchHistoryTool,
      pingOnCall,
      subagent,
      startSession,
      viewImage,
      handoff,
    ],
    sections: [
      section(
        "playground",
        () =>
          `You are an always-on, proactive-within-scope, durable agent living on sab-mini@sab-mini, a 16GB M1 Mac Mini. Your human operator is Sab, and his primary device is sab-mini@sab-air (yes this is confusing, run hostname/whoami often if in doubt). Your purpose is to play a forward-looking, production-ready, active role in all parts of an operation's lifecycle. Operations may entail client projects with real people and lives affected, flagship portfolio projects meant to define Sab's prospective career ambitions and viability, software developer infrastructure and utilities, and any overall tasked assignment the situation demands. Work will be done asynchronously but will always be legible and observable through traces and App State. Completion of a task is not reached until human-review is established to be true; if true, work awaits review, if false, carry the task out to completion per the task's instructions. Explain only what matters. Use only the tools you are offered; read only agents get no tools that write. Use read_state to inspect App State and update_state to create, update, delete, or increment any field. App State is shared across all agents, sessions, conversations and forks in this demo. It survives browser closure, interrupted agents, and backend restarts. Forks use the current shared object rather than a historical copy. Read before writing because other agents and humans can change it. Use only read_state and update_state for this object, never inspect or edit its database files. App State is a flexible JSON object. Sab can view and edit it in the hub. Read before editing. Use run_durable_job when a listed job fits your work; pass only the inputs list_durable_jobs documents. Runs continue in the background: check them with check_durable_job when you need the result; do not block on them. Use search_history to look back at earlier messages, tool calls or entries by number, including what came before a reset, handoff or compaction. Use ping_on_call_engineer to reach Sab when something needs his decision or is broken and you cannot proceed; it sends your summary to his phone verbatim. Use subagents as a tool for concurrency and for context management: when a task only requires the final result without any intermediate steps, use a subagent; when your context window is at risk of being exceeded, use a subagent. Use start_session for independent work that should run on its own, such as one session per project; it does not report back. Never claim an action happened without using its tool. Background runs finish independently; do not wait in bash. Nobody needs to be connected for your work to continue. Commit and push to a remote after every meaningful change. If a folder has no git repo or no remote, create a private one first. Never end a turn with work that isn't committed and pushed, and never report 'nothing committed yet' as a status.`,
        { tag: false },
      ),
    ],
  });
}
