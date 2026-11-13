// REST v1, same paths, bodies and status codes as dpi-backend/src/routes.ts for the parts Prime serves.
// Everything else answers 400 "Not supported on Prime yet", except where the FE needs a benign empty answer.
import { Router, type Request, type Response, type NextFunction } from "express";
import type { PrimeAgentHandle, PrimeChild } from "./driver.js";
import type { SessionRow } from "./catalog.js";
import { DEVICE_DOC_KINDS, type Service } from "./service.js";
import { agentStream, deviceStream, sessionStream } from "./streams.js";
import { idempotent } from "./idempotency.js";
import { invalid } from "./errors.js";
import { primeWorkRoutes } from "./prime-work-routes.js";

type Async = (req: Request, res: Response) => Promise<unknown>;
const route = (fn: Async) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

interface Locals {
  row: SessionRow;
  h: PrimeAgentHandle;
  /** Set when the agent is one of Prime's child agents. */
  child?: PrimeChild;
  id: number;
}

// What Prime serves for a child agent; everything else is a 400. The summary needs no live session; the rest attach the child's.
const CHILD = "/sessions/[^/]+/agents/[^/]+";
const CHILD_SUMMARY = new RegExp(`^${CHILD}/?$`);
const CHILD_ROUTES: [string, RegExp][] = [
  ["GET", new RegExp(`^${CHILD}/(events|entries|transcript|config)/?$`)],
  ["PATCH", new RegExp(`^${CHILD}/config/?$`)], // thinkingLevel only; the model is the child's own
  ["POST", new RegExp(`^${CHILD}/(messages|abort|retry-worker)/?$`)],
];

const param = (req: Request, key: string) => String(req.params[key]);
const unsupported = route(async () => {
  throw invalid("Not supported on Prime yet");
});

export function v1(svc: Service) {
  const r = Router();
  const create = idempotent(svc);

  r.param("s", (_req, res, next, value: string) => {
    try {
      res.locals.row = svc.resolveSession(value);
      next();
    } catch (e) {
      next(e);
    }
  });
  r.param("a", async (req, res, next, value: string) => {
    try {
      const target = svc.resolveAgent(param(req, "s"), value);
      if (target.child) {
        const summary = req.method === "GET" && CHILD_SUMMARY.test(req.path);
        if (!summary && !CHILD_ROUTES.some(([m, re]) => m === req.method && re.test(req.path)))
          throw invalid("Not supported on a Prime child agent. It takes GET agent, events, entries, transcript and config, PATCH config (thinkingLevel), and POST messages, abort and retry-worker");
        if (!summary) target.h = await svc.childHandle(target.row, target.child);
      }
      Object.assign(res.locals, target);
      next();
    } catch (e) {
      next(e);
    }
  });
  const L = (res: Response) => res.locals as Locals;

  // ---------------------------------------------------------- device
  r.get("/device", (_req, res) => res.json(svc.deviceInfo()));
  r.get("/tree", (_req, res) => res.json(svc.tree()));
  r.get("/events", (req, res, next) => {
    try {
      deviceStream(svc, req, res);
    } catch (e) {
      next(e);
    }
  });
  r.get("/fs/dirs", route(async (req, res) => res.json(await svc.browse(String(req.query.path ?? "")))));
  r.get("/docs/:kind", (req, res) => {
    const kind = param(req, "kind");
    if (!DEVICE_DOC_KINDS.includes(kind)) throw invalid(`Unknown device document ${kind}`);
    res.json({ kind, value: {}, revision: 0 });
  });

  // ---------------------------------------------------------- sessions
  r.get("/sessions", (_req, res) => res.json(svc.tree().sessions));
  r.post("/sessions", create, route(async (req, res) => res.status(201).json(await svc.create(req.body ?? {}))));
  r.get("/sessions/:s", (_req, res) => res.json(svc.sessionSummary(L(res).row)));
  r.patch("/sessions/:s", (req, res) => res.json(svc.rename(L(res).row, req.body?.name)));
  r.delete("/sessions/:s", route(async (_req, res) => res.json(await svc.archive(L(res).row))));
  r.get("/archived", (_req, res) => res.json(svc.archived()));
  r.post("/archived/:id/restore", route(async (req, res) => res.json(await svc.unarchive(String(req.params.id)))));
  r.get("/sessions/:s/compaction", route(async (_req, res) => res.json(await svc.handle(L(res).row).compaction())));
  r.patch("/sessions/:s/compaction", route(async (req, res) => res.json(await svc.setCompaction(L(res).row, req.body ?? {}))));
  r.get("/sessions/:s/events", (_req, res, next) => {
    try {
      sessionStream(svc, L(res).row, res);
    } catch (e) {
      next(e);
    }
  });
  r.get("/sessions/:s/tasks", route(async (req, res) => {
    const status = String(req.query.status ?? "terminal");
    if (!["live", "terminal"].includes(status)) throw invalid("status must be live or terminal");
    const t = svc.handle(L(res).row).tasks();
    res.json(status === "live" ? await t.liveTasks() : await t.terminalTasks(Math.min(Math.max(Number(req.query.limit) || 20, 1), 200)));
  }));
  r.post("/sessions/:s/tasks/:taskId/abort", route(async (req, res) => {
    const id = Number(req.params.taskId);
    if (!Number.isInteger(id)) throw invalid("taskId must be an integer");
    await svc.handle(L(res).row).tasks().abort(id);
    res.json({ status: "aborted" });
  }));
  r.get("/sessions/:s/inspect", (_req, res) => {
    svc.handle(L(res).row);
    res.json({});
  });
  r.get("/sessions/:s/submissions/:id", unsupported);

  // ---------------------------------------------------------- agents
  r.get("/sessions/:s/agents", (_req, res) => res.json(svc.agents(L(res).row)));
  r.post("/sessions/:s/agents", create, route(async (req, res) => res.status(201).json(await svc.createAgent(L(res).row, req.body ?? {}))));
  const a = "/sessions/:s/agents/:a";
  r.get(a, route(async (_req, res) => res.json(await svc.agentDetail(L(res).row, L(res).id, L(res).child))));
  r.patch(a, unsupported);
  r.get(`${a}/events`, route((req, res) => agentStream(svc, L(res), req, res)));
  r.get(`${a}/entries`, route(async (req, res) => {
    const source = svc.agentEntries(L(res).row, L(res).id);
    if (String(req.query.scope ?? "all") === "active") return void res.json({ items: JSON.parse(JSON.stringify(source)) });
    res.json(svc.entries(source, req.query.cursor as string | undefined, Number(req.query.limit ?? 500)));
  }));
  r.get(`${a}/transcript`, route(async (req, res) => res.json(svc.transcript(svc.agentEntries(L(res).row, L(res).id), String(req.query.format ?? "json")))));
  r.post(
    `${a}/messages`,
    route(async (req, res) => {
      const { id } = await svc.send(L(res).row, req.body ?? {}, L(res).id);
      res.status(202).json({ submissionId: id, status: "queued" });
    }),
  );
  r.delete(`${a}/inbox/:submissionId`, unsupported);
  r.post(`${a}/abort`, route(async (req, res) => res.json(await svc.abort(L(res).row, req.body?.background === true, L(res).id))));
  r.post(`${a}/fork`, create, route(async (req, res) => res.status(201).json(await svc.fork(L(res).row, L(res).id, req.body ?? {}))));
  r.get(`${a}/config`, (_req, res) => res.json(L(res).h.config()));
  r.patch(`${a}/config`, route(async (req, res) => res.json(await svc.configure(L(res).row, req.body ?? {}, L(res).id))));
  r.get(`${a}/extensions`, route(async (_req, res) => res.json(await L(res).h.extensions())));
  r.patch(`${a}/extensions`, route(async (req, res) => res.json(await L(res).h.patchExtensions(req.body ?? {}))));
  r.post(`${a}/compact`, route(async (req, res) => res.json(await L(res).h.compact(typeof req.body?.instructions === "string" && req.body.instructions.trim() ? req.body.instructions : undefined))));
  r.post(`${a}/retry-worker`, route(async (_req, res) => {
    await L(res).h.retryWorker();
    res.json({ ok: true });
  }));
  r.post(`${a}/reset`, route(async (req, res) => res.json(await svc.reset(L(res).row, req.body?.note))));
  r.get(`${a}/docs/:kind`, unsupported);
  r.all(`${a}/demo/{*rest}`, unsupported);

  primeWorkRoutes(r, svc);

  return r;
}
