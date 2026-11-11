// Copied from apps/dpi-backend/src/idempotency.ts; the Store type is narrowed to the two methods it uses.
import type { RequestHandler } from "express";

export interface IdempotencyStore {
  replay(key: string, route: string): { status: number; body: unknown } | undefined;
  remember(key: string, route: string, status: number, body: unknown): void;
}

/** Replays the stored response for a repeated `Idempotency-Key` on create routes. */
export function idempotent(store: IdempotencyStore): RequestHandler {
  return (req, res, next) => {
    const key = req.get("idempotency-key");
    if (!key) return next();
    if (key.length > 128) return void res.status(400).json({ error: { code: "invalid", message: "Idempotency-Key too long" } });
    const route = `${req.method} ${req.baseUrl}${req.path}`;
    const stored = store.replay(key, route);
    if (stored) return void res.status(stored.status).set("Idempotent-Replay", "true").json(stored.body);
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode < 400) store.remember(key, route, res.statusCode, body);
      return json(body);
    };
    next();
  };
}
