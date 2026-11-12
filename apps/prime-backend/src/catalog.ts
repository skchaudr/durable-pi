// Device catalog in DPI_DATA_DIR/catalog.sqlite: device uid, sessions, idempotency keys, message request ids.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface SessionRow {
  id: string;
  name: string;
  cwd: string;
  provider: string;
  model: string;
  thinkingLevel: string | null;
  createdAt: number;
  primeSessionId: string;
  archived: number;
}

/** An agent beyond the root: a session's agent 1 is the row's own primeSessionId and is not stored here. */
export interface AgentRow {
  sessionId: string;
  id: number;
  primeSessionId: string;
  name: string | null;
  kind: "root" | "fork";
  parentId: number | null;
  forkedAt: number | null;
}

export class Catalog {
  readonly db: DatabaseSync;
  readonly uid: string;
  readonly path: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.path = join(dataDir, "catalog.sqlite");
    this.db = new DatabaseSync(this.path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,name TEXT NOT NULL,cwd TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,thinkingLevel TEXT,createdAt INTEGER NOT NULL,primeSessionId TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS agents(sessionId TEXT NOT NULL,id INTEGER NOT NULL,primeSessionId TEXT NOT NULL,name TEXT,kind TEXT NOT NULL,parentId INTEGER,forkedAt INTEGER,PRIMARY KEY(sessionId,id));
      CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,route TEXT NOT NULL,status INTEGER NOT NULL,body TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sends(sessionId TEXT NOT NULL,requestId TEXT NOT NULL,submissionId INTEGER NOT NULL,PRIMARY KEY(sessionId,requestId));`);
    const cols = this.db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "archivedAt")) this.db.exec("ALTER TABLE sessions ADD COLUMN archivedAt INTEGER");
    const found = this.db.prepare("SELECT value FROM meta WHERE key='device_uid'").get() as { value: string } | undefined;
    this.uid = found?.value ?? randomUUID();
    if (!found) this.db.prepare("INSERT INTO meta(key,value) VALUES('device_uid',?)").run(this.uid);
    this.db.prepare("DELETE FROM requests WHERE createdAt < ?").run(Date.now() - 24 * 3600_000);
  }

  /** Non-archived sessions, newest first. */
  list(): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions WHERE archived=0 ORDER BY createdAt DESC").all() as unknown as SessionRow[];
  }
  get(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id=? AND archived=0").get(id) as SessionRow | undefined;
  }
  byName(name: string): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions WHERE archived=0 AND lower(name)=lower(?)").all(name) as unknown as SessionRow[];
  }
  insert(r: SessionRow) {
    this.db
      .prepare("INSERT INTO sessions(id,name,cwd,provider,model,thinkingLevel,createdAt,primeSessionId,archived) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(r.id, r.name, r.cwd, r.provider, r.model, r.thinkingLevel, r.createdAt, r.primeSessionId, r.archived);
  }
  rename(id: string, name: string) {
    this.db.prepare("UPDATE sessions SET name=? WHERE id=?").run(name, id);
  }
  setModel(id: string, provider: string, model: string) {
    this.db.prepare("UPDATE sessions SET provider=?,model=? WHERE id=?").run(provider, model, id);
  }
  setThinking(id: string, level: string) {
    this.db.prepare("UPDATE sessions SET thinkingLevel=? WHERE id=?").run(level, id);
  }
  setPrimeSession(id: string, primeSessionId: string) {
    this.db.prepare("UPDATE sessions SET primeSessionId=? WHERE id=?").run(primeSessionId, id);
  }
  archive(id: string) {
    this.db.prepare("UPDATE sessions SET archived=1,archivedAt=? WHERE id=?").run(Date.now(), id);
  }
  /** Archived sessions, newest archive first (rows archived before archivedAt existed have none). */
  archived(): (SessionRow & { archivedAt: number | null })[] {
    return this.db.prepare("SELECT * FROM sessions WHERE archived=1 ORDER BY archivedAt DESC").all() as never;
  }
  getArchived(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id=? AND archived=1").get(id) as SessionRow | undefined;
  }
  unarchive(id: string) {
    this.db.prepare("UPDATE sessions SET archived=0,archivedAt=NULL WHERE id=?").run(id);
  }

  agents(sessionId: string): AgentRow[] {
    return this.db.prepare("SELECT * FROM agents WHERE sessionId=? ORDER BY id").all(sessionId) as unknown as AgentRow[];
  }
  /** Takes the next free agent id (2 and up) and stores the row under it. */
  insertAgent(r: Omit<AgentRow, "id">): AgentRow {
    const { n } = this.db.prepare("SELECT COALESCE(MAX(id),1)+1 AS n FROM agents WHERE sessionId=?").get(r.sessionId) as { n: number };
    this.db
      .prepare("INSERT INTO agents(sessionId,id,primeSessionId,name,kind,parentId,forkedAt) VALUES(?,?,?,?,?,?,?)")
      .run(r.sessionId, n, r.primeSessionId, r.name, r.kind, r.parentId, r.forkedAt);
    return { ...r, id: n };
  }

  replay(key: string, route: string) {
    const row = this.db.prepare("SELECT * FROM requests WHERE key=?").get(key) as
      | { route: string; status: number; body: string }
      | undefined;
    if (!row) return undefined;
    return { route: row.route, status: row.status, body: JSON.parse(row.body) as unknown };
  }
  remember(key: string, route: string, status: number, body: unknown) {
    this.db.prepare("INSERT OR IGNORE INTO requests VALUES(?,?,?,?,?)").run(key, route, status, JSON.stringify(body), Date.now());
  }

  sendLookup(sessionId: string, requestId: string): number | undefined {
    const row = this.db.prepare("SELECT submissionId FROM sends WHERE sessionId=? AND requestId=?").get(sessionId, requestId) as
      | { submissionId: number }
      | undefined;
    return row?.submissionId;
  }
  sendRecord(sessionId: string, requestId: string, submissionId: number) {
    this.db.prepare("INSERT OR IGNORE INTO sends VALUES(?,?,?)").run(sessionId, requestId, submissionId);
  }

  close() {
    this.db.close();
  }
}
