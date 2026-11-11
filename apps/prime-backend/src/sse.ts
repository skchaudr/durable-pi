// SSE plumbing, copied from apps/dpi-backend/src/streams.ts (openSse, coalesce, parseDocs, diffActivity).
import type { Response } from "express";
import type { Activity, DeviceTree, Frame, StreamScope } from "../../dpi-sdk/src/api.js";
import { invalid } from "./errors.js";

const MAX_BUFFER = 2_000_000;

export interface Sse {
  send(frame: Frame): void;
  readonly closed: boolean;
  onClose(fn: () => void): void;
  sendIfChanged(key: string, frame: Frame): void;
}

export function openSse(res: Response, scope: StreamScope): Sse {
  res.status(200).set({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders();
  res.socket?.setNoDelay(true);
  let seq = 0;
  let closed = false;
  const cleanups: Array<() => void> = [];
  const last = new Map<string, string>();
  const ping = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, 15_000);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {}
    }
  };
  res.on("close", close);
  const send = (frame: Frame) => {
    if (closed) return;
    if (res.writableLength > MAX_BUFFER) {
      // A slow viewer reconnects to a fresh snapshot instead of buffering without bound.
      res.end();
      close();
      return;
    }
    res.write(`id: ${++seq}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  };
  send({ type: "hello", apiVersion: 1, serverTime: Date.now(), scope });
  return {
    send,
    get closed() {
      return closed;
    },
    onClose(fn) {
      if (closed) fn();
      else cleanups.push(fn);
    },
    sendIfChanged(key, frame) {
      const json = JSON.stringify(frame);
      if (last.get(key) === json) return;
      last.set(key, json);
      send(frame);
    },
  };
}

/** Run `fn` at most once per `ms`, never concurrently, always catching up on the latest trigger. */
export function coalesce(fn: () => Promise<void>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  const run = async () => {
    timer = undefined;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await fn();
    } catch (e) {
      console.error("[prime-backend] stream update failed:", e instanceof Error ? e.message : e);
    } finally {
      running = false;
      if (again) {
        again = false;
        trigger();
      }
    }
  };
  const trigger = () => {
    if (!timer) timer = setTimeout(() => void run(), ms);
  };
  return Object.assign(trigger, { now: run, cancel: () => timer && clearTimeout(timer) });
}

export function parseDocs(raw: unknown, allowed: readonly string[]): string[] {
  if (raw === undefined || raw === "") return [];
  if (typeof raw !== "string") throw invalid("docs must be a comma-separated list");
  const kinds = [...new Set(raw.split(",").map((k) => k.trim()).filter(Boolean))];
  for (const kind of kinds)
    if (!allowed.includes(kind)) throw invalid(`Unknown document ${kind}. Allowed: ${allowed.join(", ")}`);
  return kinds;
}

export function diffActivity(prev: DeviceTree | undefined, next: DeviceTree): Activity[] {
  if (!prev) return [];
  const before = new Map(prev.sessions.flatMap((s) => s.agents.map((a) => [`${s.id}/${a.id}`, a.busy] as const)));
  return next.sessions.flatMap((s) =>
    s.agents.flatMap((a): Activity[] => {
      const was = before.get(`${s.id}/${a.id}`) ?? false;
      if (was === a.busy) return [];
      return [{ type: a.busy ? "agent.started" : "agent.finished", sessionId: s.id, agentId: a.id, at: next.at }];
    }),
  );
}
