// REST v1, same paths, bodies and status codes as dpi-backend/src/routes.ts for the parts Prime serves.
// Everything else answers 400 "Not supported on Prime yet", except where the FE needs a benign empty answer.
import { Router, type Request, type Response, type NextFunction } from "express";
import type { PrimeAgentHandle } from "./driver.js";
import type { SessionRow } from "./catalog.js";
import { DEVICE_DOC_KINDS, type Service } from "./service.js";
import { agentStream, deviceStream, sessionStream } from "./streams.js";
import { idempotent } from "./idempotency.js";
import { invalid } from "./errors.js";

type Async = (req: Request, res: Response) => Promise<unknown>;
const route = (fn: Async) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

interface Locals {
  row: SessionRow;
  h: PrimeAgentHandle;
}

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
  r.param("a", (req, res, next, value: string) => {
    try {
      Object.assign(res.locals, svc.resolveAgent(param(req, "s"), value));
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
  r.get("/sessions/:s/compaction", unsupported);
  r.patch("/sessions/:s/compaction", unsupported);
  r.get("/sessions/:s/events", (_req, res, next) => {
    try {
      sessionStream(svc, L(res).row, res);
    } catch (e) {
      next(e);
    }
  });
  r.get("/sessions/:s/tasks", (req, res) => {
    const status = String(req.query.status ?? "terminal");
    if (!["live", "terminal"].includes(status)) throw invalid("status must be live or terminal");
    svc.handle(L(res).row);
    res.json([]);
  });
  r.post("/sessions/:s/tasks/:taskId/abort", unsupported);
  r.get("/sessions/:s/inspect", (_req, res) => {
    svc.handle(L(res).row);
    res.json({});
  });
  r.get("/sessions/:s/submissions/:id", unsupported);

  // ---------------------------------------------------------- agents
  r.get("/sessions/:s/agents", (_req, res) => res.json(svc.agents(L(res).row)));
  r.post("/sessions/:s/agents", unsupported);
  const a = "/sessions/:s/agents/:a";
  r.get(a, (_req, res) => res.json(svc.agentDetail(L(res).row)));
  r.patch(a, unsupported);
  r.get(`${a}/events`, (req, res, next) => {
    try {
      agentStream(svc, L(res), req, res);
    } catch (e) {
      next(e);
    }
  });
  r.get(`${a}/entries`, (req, res) => {
    const scope = String(req.query.scope ?? "all");
    if (scope === "active") return void res.json({ items: svc.activeEntries(L(res).row) });
    res.json(svc.entries(L(res).row, req.query.cursor as string | undefined, Number(req.query.limit ?? 500)));
  });
  r.get(`${a}/transcript`, (req, res) => res.json(svc.transcript(L(res).row, String(req.query.format ?? "json"))));
  r.post(
    `${a}/messages`,
    route(async (req, res) => {
      const { id } = await svc.send(L(res).row, req.body ?? {});
      res.status(202).json({ submissionId: id, status: "queued" });
    }),
  );
  r.delete(`${a}/inbox/:submissionId`, unsupported);
  r.post(`${a}/abort`, route(async (_req, res) => res.json(await svc.abort(L(res).row))));
  r.post(`${a}/fork`, unsupported);
  r.get(`${a}/config`, (_req, res) => res.json(L(res).h.config()));
  r.patch(`${a}/config`, route(async (req, res) => res.json(await svc.configure(L(res).row, req.body ?? {}))));
  r.get(`${a}/extensions`, (_req, res) => res.json({ extensions: [], builtIn: [] }));
  r.patch(`${a}/extensions`, unsupported);
  r.post(`${a}/compact`, unsupported);
  r.post(`${a}/reset`, unsupported);
  r.get(`${a}/docs/:kind`, unsupported);
  r.all(`${a}/demo/{*rest}`, unsupported);

  return r;
}
