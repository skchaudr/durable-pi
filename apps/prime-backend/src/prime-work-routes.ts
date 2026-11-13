// Prime's goal, heartbeat and schedules as REST (dpi-sdk/src/prime.ts). Mounted by routes.ts on the same router, so the
// `:s` param resolves the session there. Prime has no goal RPC: a goal is a `/goal` prompt, queued behind a running turn.
import type { NextFunction, Request, Response, Router } from "express";
import type { SessionRow } from "./catalog.js";
import type { TaskSource } from "./driver.js";
import type { Service } from "./service.js";
import type { PrimeGoalAction, PrimeHeartbeatAction, PrimeJob } from "../../dpi-sdk/src/prime.js";
import { ApiFault, invalid } from "./errors.js";

type Async = (req: Request, res: Response) => Promise<unknown>;
const route = (fn: Async) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === "object" ? req.body : {});

/** schedule and prompt must be given: runJob's defaults ("in 1h", a canned prompt) are for the chat tools, not for a form. */
function textInputs(b: Record<string, unknown>) {
  if (typeof b.schedule !== "string" || typeof b.prompt !== "string") throw invalid("schedule and prompt are required strings");
  return { schedule: b.schedule, prompt: b.prompt };
}

export function primeWorkRoutes(r: Router, svc: Service) {
  const tasks = (res: Response): TaskSource => svc.handle((res.locals as { row: SessionRow }).row).tasks();
  // runJob refreshed Prime's state, so the new job is in workNow().
  const created = (t: TaskSource, jobId: string | undefined): PrimeJob => {
    const w = t.workNow();
    const job = [w.heartbeat, ...w.schedules].find((j) => j?.id === jobId);
    if (!job) throw new ApiFault("internal", `Prime did not report job ${jobId}`);
    return job;
  };
  const p = "/sessions/:s/prime";

  r.get(`${p}/work`, route(async (_req, res) => res.json(await tasks(res).work())));

  r.put(`${p}/goal`, route(async (req, res) => {
    const { objective, tokenBudget } = body(req);
    const { queued } = await tasks(res).runJob("prime.goal", { objective, tokenBudget });
    res.json({ queued: queued === true });
  }));
  r.post(`${p}/goal/:action`, route(async (req, res) => res.json(await tasks(res).goalCommand(String(req.params.action) as PrimeGoalAction))));

  r.put(`${p}/heartbeat`, route(async (req, res) => {
    const t = tasks(res);
    const { jobId } = await t.runJob("prime.heartbeat", { ...textInputs(body(req)), deliveryMode: body(req).deliveryMode });
    res.json(created(t, jobId));
  }));
  r.post(`${p}/heartbeat/:jobId/:action`, route(async (req, res) => {
    await tasks(res).heartbeatAction(String(req.params.jobId), String(req.params.action) as PrimeHeartbeatAction);
    res.json({ status: "ok" });
  }));

  r.post(`${p}/schedules`, route(async (req, res) => {
    const t = tasks(res);
    const { jobId } = await t.runJob("prime.schedule", textInputs(body(req)));
    res.status(201).json(created(t, jobId));
  }));
  r.put(`${p}/schedules/:jobId`, route(async (req, res) => {
    const t = tasks(res);
    const { jobId, replaced } = await t.editSchedule(String(req.params.jobId), textInputs(body(req)));
    res.json({ job: created(t, jobId), replaced });
  }));
  r.delete(`${p}/schedules/:jobId`, route(async (req, res) => {
    await tasks(res).cancelSchedule(String(req.params.jobId));
    res.json({ status: "cancelled" });
  }));
}
