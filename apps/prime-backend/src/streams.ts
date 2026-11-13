// Server-Sent Event streams, same frames and cadence as dpi-backend/src/streams.ts.
import type { Request, Response } from "express";
import type { DeviceTree, WireAgentEvent } from "../../dpi-sdk/src/api.js";
import type { PrimeAgentHandle, PrimeChild } from "./driver.js";
import type { SessionRow } from "./catalog.js";
import { AGENT_DOC_KINDS, DEVICE_DOC_KINDS, type Service } from "./service.js";
import { coalesce, diffActivity, openSse, parseDocs } from "./sse.js";

/** Empty `JobRunsDoc` (dpi-sdk/src/jobs.ts), the default dpi-backend answers for `demo.job-runs`. */
const EMPTY_DOCS: Record<string, unknown> = { "demo.job-runs": { counts: {}, items: {} }, "demo.workspace": {} };

export function deviceStream(svc: Service, req: Request, res: Response) {
  const docs = parseDocs(req.query.docs, DEVICE_DOC_KINDS);
  const sse = openSse(res, { kind: "device" });
  let previous: DeviceTree | undefined;
  const push = coalesce(async () => {
    if (sse.closed) return;
    const tree = svc.tree();
    const { at: _at, ...stable } = tree;
    const items = diffActivity(previous, tree);
    previous = tree;
    sse.sendIfChanged("tree", { type: "tree", tree: { ...stable, at: 0 } });
    if (items.length) {
      for (const item of items)
        if (item.type === "agent.finished") {
          const row = svc.list().find((r) => r.id === item.sessionId);
          if (row) item.preview = svc.preview(row);
        }
      sse.send({ type: "activity", items });
    }
    for (const kind of docs) sse.sendIfChanged(`doc:${kind}`, { type: "doc", kind, value: {}, revision: 0 });
  }, 250);
  sse.onClose(svc.subscribe(push));
  sse.onClose(() => push.cancel());
  void push.now();
}

export function sessionStream(svc: Service, row: SessionRow, res: Response) {
  const handle = svc.handle(row);
  const sse = openSse(res, { kind: "session", sessionId: row.id });
  const tasks = handle.tasks();
  const liveTasks = () => tasks.liveTasks().catch(() => []);
  void liveTasks().then((t) => {
    if (sse.closed) return;
    sse.send({ type: "session", agents: svc.agents(row), tasks: t, usage: svc.usage(row) });
    sse.sendIfChanged("tasks", { type: "tasks", tasks: t });
  });
  const push = coalesce(async () => {
    if (sse.closed || !svc.handles.has(row.id)) return;
    sse.sendIfChanged("agents", { type: "agents", agents: svc.agents(row) });
    sse.sendIfChanged("usage", { type: "usage", usage: svc.usage(row) });
    sse.sendIfChanged("tasks", { type: "tasks", tasks: await liveTasks() });
  }, 250);
  const off = handle.subscribe(() => push());
  const offCatalog = svc.subscribe(() => push());
  const offTasks = tasks.onChange(() => push());
  sse.onClose(() => {
    off();
    offCatalog();
    offTasks();
    push.cancel();
  });
}

export async function agentStream(_svc: Service, target: { row: SessionRow; h: PrimeAgentHandle; id: number; child?: PrimeChild }, req: Request, res: Response) {
  const { row, h, id } = target;
  const docs = parseDocs(req.query.docs, AGENT_DOC_KINDS);
  const sse = openSse(res, { kind: "agent", sessionId: row.id, agentId: id });
  // Snapshot and subscription happen in one synchronous run, so no batch falls between them.
  const snapshot = JSON.parse(JSON.stringify(h.snapshot()));
  const off = h.subscribe((events) => {
    if (sse.closed) return;
    const batch: readonly WireAgentEvent[] = JSON.parse(JSON.stringify(events));
    sse.send({ type: "batch", events: batch });
    if (batch.some((e) => e.type === "inbox_update" || e.type === "snapshot")) sse.send({ type: "inbox", items: [] });
  });
  sse.onClose(off);
  sse.send({ type: "snapshot", snapshot, inbox: [] });
  for (const kind of docs) sse.sendIfChanged(`doc:${kind}`, { type: "doc", kind, value: EMPTY_DOCS[kind] });
}
