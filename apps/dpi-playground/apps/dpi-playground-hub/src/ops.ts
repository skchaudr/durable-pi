// Proxy to the proactive demo's ops service (/api/ops/<ops path> → <OPS_URL><ops path>). It only ever
// talks to the configured OPS_URL, and only to the routes the Incidents tab needs: the ops service also
// has routes that drive its agents, which the hub does not hand to browsers.
import type { RequestHandler } from "express";

const err = (code: string, message: string) => ({ error: { code, message } });
const ALLOWED = [
  /^GET \/api\/(incidents|deploys|stream)$/,
  /^GET \/api\/incidents\/[\w-]+\/review$/,
  /^POST \/api\/deploys\/\d+\/decide$/,
];

export function opsProxy(opsUrl: string): RequestHandler {
  const base = opsUrl.replace(/\/+$/, "");
  return async (req, res) => {
    const path = req.originalUrl.slice("/api/ops".length);
    if (!ALLOWED.some((r) => r.test(`${req.method} ${path}`)))
      return void res.status(404).json(err("not_found", "Ops route not available"));
    const stream = path === "/api/stream";
    const closed = new AbortController();
    res.on("close", () => closed.abort());
    try {
      const upstream = await fetch(base + path, {
        method: req.method,
        headers: req.method === "POST" ? { "content-type": "application/json" } : {},
        body: req.method === "POST" ? JSON.stringify(req.body ?? {}) : undefined,
        signal: stream ? closed.signal : AbortSignal.any([closed.signal, AbortSignal.timeout(30_000)]),
      });
      if (!stream || !upstream.ok || !upstream.body)
        return void res
          .status(upstream.status)
          .type(upstream.headers.get("content-type") ?? "application/json")
          .send(await upstream.text());
      res.status(200).set({
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.flushHeaders();
      const reader = upstream.body.getReader();
      for (let c = await reader.read(); !c.done; c = await reader.read()) {
        if (res.writableLength > 4_000_000) break; // a slow viewer reconnects to a fresh snapshot
        res.write(c.value);
      }
      void reader.cancel();
      res.end();
    } catch (e) {
      if (closed.signal.aborted) return;
      if (res.headersSent) return void res.end();
      res.status(503).json(err("unavailable", `Ops service at ${base} did not answer: ${(e as Error).message}`));
    }
  };
}
