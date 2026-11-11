import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp } from "../src/app.js";
import { FakeDriver } from "../src/fake-driver.js";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import type { Frame } from "../../dpi-sdk/src/api.js";

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(fn: () => boolean | Promise<boolean>, timeout = 5000, what = "condition") {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(10);
  }
  throw Error(`Timed out waiting for ${what}`);
}

export interface Booted {
  base: string;
  token: string;
  dir: string;
  work: string;
  driver: FakeDriver;
  client: DpiClient;
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: Headers }>;
  tail(path: string): Tail;
  stop(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface Tail {
  frames: Frame[];
  waitFor(pred: (f: Frame, i: number) => boolean, what?: string): Promise<Frame>;
  stop(): void;
  error?: unknown;
}

/** Boots the app on an ephemeral port with a FakeDriver. Pass `dir`/`token` to restart against the same catalog. */
export async function boot(opts: { dir?: string; token?: string; driver?: FakeDriver } = {}): Promise<Booted> {
  const dir = opts.dir ?? (await realpath(await mkdtemp(join(tmpdir(), "prime-be-"))));
  const work = join(dir, "work");
  await mkdir(join(work, "project"), { recursive: true });
  const token = opts.token ?? randomBytes(24).toString("hex");
  const driver = opts.driver ?? new FakeDriver();
  const { app, svc } = await createApp({ dataDir: join(dir, "data"), startDirs: [work], name: "test-prime", token }, driver);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new DpiClient(base, token);
  const tails: Tail[] = [];
  return {
    base,
    token,
    dir,
    work,
    driver,
    client,
    async call(method, path, body, headers = {}) {
      const res = await fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
    },
    tail(path) {
      const ctl = new AbortController();
      const frames: Frame[] = [];
      const t: Tail = {
        frames,
        stop: () => ctl.abort(),
        async waitFor(pred, what = "frame") {
          let seen = 0;
          let found: Frame | undefined;
          await until(() => {
            if (t.error) throw t.error;
            for (; seen < frames.length; seen++) if (pred(frames[seen], seen)) return !!(found = frames[seen]);
            return false;
          }, 5000, what);
          return found!;
        },
      };
      void (async () => {
        try {
          for await (const f of client.stream(path, ctl.signal)) frames.push(f);
        } catch (e) {
          t.error = e;
        }
      })();
      tails.push(t);
      return t;
    },
    async stop() {
      for (const t of tails) t.stop();
      server.closeAllConnections();
      server.close();
      await svc.close();
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export const newSession = async (b: Booted, name = "work one") =>
  (await b.call("POST", "/v1/sessions", { name, cwd: b.work, model: { provider: "fake", modelId: "echo" } })).body;
