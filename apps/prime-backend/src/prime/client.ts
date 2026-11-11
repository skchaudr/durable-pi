// Prime daemon socket client: JSONL over a unix socket (crates/pa-tui/src/daemon_client.rs). The supervisor sends
// `daemon_hello` on connect; commands go as `type:"command"` envelopes; `type:"response"` frames answer by envelope id;
// everything else (session_event, session_binding, ...) is an event frame.
import { EventEmitter } from "node:events";
import net from "node:net";

export const PROTOCOL = { name: "prime-agent.daemon", version: 7 } as const;

export class PrimeError extends Error {
  constructor(
    message: string,
    readonly command: string,
    /** `errorInfo.code` from the daemon, or "connection" / "timeout" for transport failures. */
    readonly code?: string,
  ) {
    super(message);
  }
  get transport() {
    return this.code === "connection" || this.code === "timeout";
  }
}

export interface SessionEventFrame {
  type: "session_event";
  activeSessionId: string;
  event: any;
  meta?: { sequence?: number; replayed?: boolean };
}

export interface ClientOptions {
  clientId?: string;
  requestTimeoutMs?: number;
  helloTimeoutMs?: number;
  /** Delay before reconnect attempt n (last value repeats). */
  backoffMs?: readonly number[];
}

/** Emits: `session_event` (SessionEventFrame), `frame` (any other non-response frame), `connected` (hello, reconnect:boolean), `disconnected`. */
export class DaemonClient extends EventEmitter {
  private sock?: net.Socket;
  private ready?: Promise<void>;
  private settle?: { resolve(): void; reject(e: Error): void };
  private pending = new Map<string, { resolve(d: any): void; reject(e: Error): void; command: string; timer: NodeJS.Timeout }>();
  private nextId = 0;
  private closed = false;
  private everConnected = false;
  private retry?: NodeJS.Timeout;
  private failures = 0;
  hello: any;

  constructor(
    readonly socketPath: string,
    private readonly opts: ClientOptions = {},
  ) {
    super();
  }

  private get backoff() {
    return this.opts.backoffMs ?? [250, 500, 1000, 2000, 5000];
  }

  /** Connects and waits for the hello; retries `attempts` times with backoff, then throws. Afterwards it reconnects forever. */
  async connect(attempts = 3): Promise<void> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.dial();
        return;
      } catch (e) {
        last = e;
        if (this.closed) break;
        await new Promise((r) => setTimeout(r, this.backoff[Math.min(i, this.backoff.length - 1)]));
      }
    }
    throw last instanceof Error ? last : Error(String(last));
  }

  private dial(): Promise<void> {
    if (this.ready) return this.ready;
    const ready = new Promise<void>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    this.ready = ready;
    ready.catch(() => {});
    const sock = net.connect(this.socketPath);
    sock.setEncoding("utf8");
    this.sock = sock;
    let buf = "";
    const helloTimer = setTimeout(
      () => sock.destroy(Error(`no daemon_hello from ${this.socketPath} within ${this.opts.helloTimeoutMs ?? 15000}ms`)),
      this.opts.helloTimeoutMs ?? 15000,
    );
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let frame: any;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame && typeof frame === "object") this.onFrame(frame, helloTimer);
      }
    });
    sock.on("error", () => {}); // 'close' follows
    sock.on("close", () => {
      clearTimeout(helloTimer);
      if (this.sock !== sock) return;
      this.sock = undefined;
      const wasUp = this.settle === undefined;
      this.ready = undefined;
      this.settle?.reject(Error(`daemon socket ${this.socketPath} closed before hello`));
      this.settle = undefined;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new PrimeError("the daemon connection closed", p.command, "connection"));
      }
      if (wasUp) this.emit("disconnected");
      if (!this.closed && this.everConnected) this.scheduleReconnect(this.failures++);
    });
    return ready;
  }

  private scheduleReconnect(attempt: number) {  // a failed dial closes the socket, which lands back here with a longer delay
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.dial().catch(() => {});
    }, this.backoff[Math.min(attempt, this.backoff.length - 1)]);
  }

  private onFrame(frame: any, helloTimer: NodeJS.Timeout) {
    switch (frame.type) {
      case "daemon_hello": {
        if (!this.settle) return;
        clearTimeout(helloTimer);
        if (frame.protocol?.name !== PROTOCOL.name) {
          this.sock?.destroy();
          return this.settle.reject(Error(`${this.socketPath} speaks protocol "${frame.protocol?.name}"`));
        }
        this.hello = frame;
        const reconnect = this.everConnected;
        this.everConnected = true;
        this.failures = 0;
        this.settle.resolve();
        this.settle = undefined;
        this.emit("connected", frame, reconnect);
        return;
      }
      case "response": {
        const p = this.pending.get(frame.id);
        if (!p) return;
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.success) p.resolve(frame.data);
        else p.reject(new PrimeError(frame.error ?? "unknown daemon error", p.command, frame.errorInfo?.code));
        return;
      }
      case "session_event":
        return void this.emit("session_event", frame as SessionEventFrame);
      default:
        return void this.emit("frame", frame);
    }
  }

  /** Sends one command and resolves with the response `data`. Waits for the connection (up to the timeout) if it is down. */
  async request(command: { type: string; [k: string]: unknown }, timeoutMs = this.opts.requestTimeoutMs ?? 30000): Promise<any> {
    if (this.closed) throw new PrimeError("the daemon client is closed", command.type, "connection");
    if (!this.sock || this.settle) {
      // After a first connect the reconnect loop owns the socket: wait for its next `connected`.
      const up = this.everConnected
        ? new Promise<void>((resolve) => this.once("connected", () => resolve()))
        : (this.ready ?? this.dial());
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        up,
        new Promise((_, rej) => (timer = setTimeout(() => rej(new PrimeError("the daemon is not connected", command.type, "connection")), timeoutMs))),
      ])
        .catch((e) => {
          throw e instanceof PrimeError ? e : new PrimeError(String(e?.message ?? e), command.type, "connection");
        })
        .finally(() => clearTimeout(timer));
    }
    const sock = this.sock;
    if (!sock) throw new PrimeError("the daemon is not connected", command.type, "connection");
    const id = `pb_${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PrimeError(`no daemon response to ${command.type} within ${timeoutMs}ms`, command.type, "timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, command: command.type, timer });
      const envelope = { type: "command", id, protocol: PROTOCOL, clientId: this.opts.clientId ?? `prime-backend:${process.pid}`, command };
      sock.write(JSON.stringify(envelope) + "\n");
    });
  }

  close() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.sock?.destroy();
  }
}
