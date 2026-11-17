/**
 * The durable job queue every module shares: one host-owned table,
 * `__module_jobs`, in the app's database. Rows carry the module, job
 * name, the caller (user + vault session) and the payload, encrypted with
 * the module's own vault scope - so job payloads are as protected at rest
 * as the module's tables, and only that module can read them.
 */

export const JOBS_TABLE = "__module_jobs";

export const JOBS_DDL = `
CREATE TABLE IF NOT EXISTS ${JOBS_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module TEXT NOT NULL,
  name TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  payload BLOB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  run_at INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ${JOBS_TABLE}_due ON ${JOBS_TABLE} (status, run_at);
`;

export interface JobRow {
  id: number;
  module: string;
  name: string;
  user_id: number;
  session_id: string;
  payload: Buffer;
  status: "queued" | "running" | "done" | "failed";
  attempts: number;
  max_attempts: number;
  run_at: number;
  error: string | null;
}

/** The slice of better-sqlite3 the queue needs (whatever copy the app uses). */
export interface RawSqlite {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export function createJobStore(sqlite: RawSqlite) {
  const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");
  return {
    ensureTable(): void {
      sqlite.exec(JOBS_DDL);
    },

    insert(row: { module: string; name: string; userId: number; sessionId: string; payload: Buffer; maxAttempts: number; runAt: number }): number {
      const now = Date.now();
      const result = sqlite
        .prepare(
          `INSERT INTO ${JOBS_TABLE} (module, name, user_id, session_id, payload, status, attempts, max_attempts, run_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
        )
        .run(row.module, row.name, row.userId, row.sessionId, row.payload, row.maxAttempts, row.runAt, now, now);
      return Number(result.lastInsertRowid);
    },

    /** Atomically claims the next due job of one of `modules`, or undefined. */
    claimNext(modules: readonly string[], now: number): JobRow | undefined {
      if (modules.length === 0) return undefined;
      for (;;) {
        const next = sqlite
          .prepare(
            `SELECT * FROM ${JOBS_TABLE} WHERE status = 'queued' AND run_at <= ? AND module IN (${placeholders(modules.length)})
             ORDER BY run_at, id LIMIT 1`,
          )
          .get(now, ...modules) as JobRow | undefined;
        if (!next) return undefined;
        const claimed = sqlite
          .prepare(`UPDATE ${JOBS_TABLE} SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'`)
          .run(now, next.id);
        if (claimed.changes === 1) return { ...next, status: "running" };
        // Someone else claimed it between the two statements - try the next one.
      }
    },

    /** Back to the queue without counting an attempt (the vault was locked, nothing ran). */
    defer(id: number, runAt: number): void {
      sqlite.prepare(`UPDATE ${JOBS_TABLE} SET status = 'queued', run_at = ?, updated_at = ? WHERE id = ?`).run(runAt, Date.now(), id);
    },

    done(id: number): void {
      sqlite.prepare(`UPDATE ${JOBS_TABLE} SET status = 'done', error = NULL, updated_at = ? WHERE id = ?`).run(Date.now(), id);
    },

    /** Counts an attempt; requeues at `retryAt`, or fails for good once attempts run out. */
    fail(row: JobRow, errorCode: string, retryAt: number): "retry" | "failed" {
      const attempts = row.attempts + 1;
      const final = attempts >= row.max_attempts;
      sqlite
        .prepare(`UPDATE ${JOBS_TABLE} SET status = ?, attempts = ?, error = ?, run_at = ?, updated_at = ? WHERE id = ?`)
        .run(final ? "failed" : "queued", attempts, errorCode, final ? row.run_at : retryAt, Date.now(), row.id);
      return final ? "failed" : "retry";
    },

    /** After a crash, `running` rows of these modules never finished - requeue them. */
    recoverRunning(modules: readonly string[]): number {
      if (modules.length === 0) return 0;
      return sqlite
        .prepare(`UPDATE ${JOBS_TABLE} SET status = 'queued', updated_at = ? WHERE status = 'running' AND module IN (${placeholders(modules.length)})`)
        .run(Date.now(), ...modules).changes;
    },

    get(id: number): JobRow | undefined {
      return sqlite.prepare(`SELECT * FROM ${JOBS_TABLE} WHERE id = ?`).get(id) as JobRow | undefined;
    },
  };
}

export type JobStore = ReturnType<typeof createJobStore>;

/** 1s, 2s, 4s... capped at 5 minutes. */
export function retryDelayMs(attempts: number): number {
  return Math.min(1000 * 2 ** attempts, 5 * 60_000);
}
