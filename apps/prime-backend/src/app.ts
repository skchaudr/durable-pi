// The Express app, separate from main.ts so tests can run it against a FakeDriver.
import express from "express";
import { bearerAuth } from "./auth.js";
import { errorMiddleware } from "./errors.js";
import { v1 } from "./routes.js";
import { Service, type ServiceOptions } from "./service.js";
import type { PrimeDriver } from "./driver.js";

export async function createApp(options: ServiceOptions & { token: string }, driver: PrimeDriver) {
  const { token, ...serviceOptions } = options;
  const svc = await Service.open(serviceOptions, driver);
  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.use("/v1", bearerAuth(token), express.json({ limit: "256kb" }), v1(svc));
  app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "Route not found" } }));
  app.use(errorMiddleware);
  return { app, svc };
}
