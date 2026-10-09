import { AsyncLocalStorage } from "node:async_hooks";
import { access } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { withFileLock } from "@dev.fast/trace-core";

import type {
  MetadataDialect,
  MetadataParam,
  MetadataRow,
  MetadataStoreConfig,
} from "./metadata-store.js";

const jsonPath = (path: string) => `$.${path}`;

/** SQLITE_BUSY's canonical message. The synchronous busy handler is off, so
 * contention surfaces as this error and the adapter retries asynchronously. */
const isBusy = (cause: unknown) =>
  cause instanceof Error && cause.message === "database is locked";

const SQLITE_DIALECT: MetadataDialect = {
  jsonText: (column, path) => `json_extract(${column},'${jsonPath(path)}')`,
  jsonWithout: (column, key) => `json_remove(${column},'$.${key}')`,
  jsonFlag: (column, path) =>
    `COALESCE(json_extract(${column},'${jsonPath(path)}'),0) = 1`,
  containsText: (column) => `instr(${column}, ?) > 0`,
};

/** The review-api.db schema. Every statement is idempotent so an existing
 * data directory opens without migration; the shapes are byte-for-byte the
 * ones the synchronous store created on first run. */
const REVIEW_SCHEMA = `
  CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, version INTEGER NOT NULL, next_id INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS versions(review_id TEXT REFERENCES reviews(id), version INTEGER, snapshot TEXT NOT NULL,
    PRIMARY KEY(review_id,version));
  DROP TABLE IF EXISTS receipts;
  CREATE TABLE IF NOT EXISTS review_attention(review_id TEXT PRIMARY KEY REFERENCES reviews(id), viewed_at TEXT, dismissed_at TEXT);
  CREATE TABLE IF NOT EXISTS repositories(id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id),
    kind TEXT NOT NULL, mime_type TEXT NOT NULL, data BLOB NOT NULL);
  CREATE TABLE IF NOT EXISTS review_coverage(review_id TEXT REFERENCES reviews(id), file TEXT, fingerprint TEXT NOT NULL, coverage TEXT NOT NULL,
    PRIMARY KEY(review_id,file));
  DROP TABLE IF EXISTS review_viewed;
  CREATE TABLE IF NOT EXISTS comparison_stats(identity TEXT PRIMARY KEY, stats TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS server_identity(one INTEGER PRIMARY KEY CHECK(one=1), id TEXT NOT NULL);
  DROP TABLE IF EXISTS authoring_drafts;
  CREATE TABLE IF NOT EXISTS authoring_presences(
    activity_id TEXT PRIMARY KEY, review_id TEXT NOT NULL, slot INTEGER NOT NULL,
    started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, focus TEXT, surface TEXT);
  DROP TABLE IF EXISTS authoring_sessions;
  CREATE TABLE IF NOT EXISTS ask_conversations(
    id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    session_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    head TEXT NOT NULL,
    cwd TEXT NOT NULL,
    selection TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    entries TEXT,
    bypass INTEGER NOT NULL DEFAULT 0,
    UNIQUE(agent, session_id));
  CREATE INDEX IF NOT EXISTS ask_conversations_review ON ask_conversations(review_id, updated_at);
  CREATE TABLE IF NOT EXISTS ask_agent_offers(agent TEXT PRIMARY KEY, offer TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ask_agent_model_offers(agent TEXT NOT NULL, model TEXT NOT NULL, offer TEXT NOT NULL, PRIMARY KEY(agent, model));
  CREATE TABLE IF NOT EXISTS headless_imports(path TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS jobs_jobs(
    id TEXT PRIMARY KEY, job_key TEXT NOT NULL UNIQUE, type TEXT NOT NULL, input TEXT NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER,
    review_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS jobs_jobs_claim ON jobs_jobs(status, lease_until, created_at);`;

/** The `.workspaces` sidecar's tables, byte-for-byte what the synchronous
 * workspace manager created. */
const WORKSPACE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pinned_environments(id TEXT PRIMARY KEY, value TEXT NOT NULL);
  DROP TABLE IF EXISTS workspace_owner;
  CREATE TABLE IF NOT EXISTS workspace_leases(review_id TEXT PRIMARY KEY,owner TEXT NOT NULL,pid INTEGER NOT NULL);`;

export class SqliteMetadataStore {
  readonly kind = "sqlite";
  readonly dialect = SQLITE_DIALECT;
  private readonly db: DatabaseSync;
  private readonly tx = new AsyncLocalStorage<true>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(
    db: DatabaseSync,
    private readonly schema: "review" | "workspace",
  ) {
    this.db = db;
  }

  static async open(
    config: Extract<MetadataStoreConfig, { kind: "sqlite" }>,
  ): Promise<SqliteMetadataStore> {
    const schema = config.schema ?? "review";

    const store = new SqliteMetadataStore(
      config.readonly
        ? new DatabaseSync(config.dir, { readOnly: true, timeout: 5000 })
        : new DatabaseSync(config.dir, { timeout: 0 }),
      schema,
    );

    if (!config.readonly) store.initialize();

    return store;
  }

  private initialize() {
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`);
    this.db.exec(
      this.schema === "workspace" ? WORKSPACE_SCHEMA : REVIEW_SCHEMA,
    );

    // Conversations saved before bypassing permissions lack the column.
    if (
      this.schema === "review" &&
      !this.db
        .prepare("PRAGMA table_info(ask_conversations)")
        .all()
        .some((column) => String(column.name) === "bypass")
    )
      this.db.exec(
        "ALTER TABLE ask_conversations ADD COLUMN bypass INTEGER NOT NULL DEFAULT 0",
      );
  }

  /** Serializes work on the one connection, as the synchronous driver did.
   * Calls made inside a transaction's async context join it directly instead
   * of queueing behind it. */
  private enqueue<T>(job: () => T): Promise<T> {
    if (this.tx.getStore()) return Promise.resolve().then(job);

    if (this.closed)
      return Promise.reject(new Error("The metadata store is closed."));

    const run = this.queue.then(() => this.withBusyRetry(job));
    this.queue = run.catch(() => {});

    return run;
  }

  /** sqlite's own busy handler sleeps inside the synchronous call, starving the
   * async work that would release the lock. Retry on the event loop instead. */
  private async withBusyRetry<T>(job: () => T): Promise<T> {
    const deadline = Date.now() + 5000;

    for (;;) {
      try {
        return job();
      } catch (error) {
        if (!isBusy(error) || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  async all<T = MetadataRow>(
    sql: string,
    ...params: MetadataParam[]
  ): Promise<T[]> {
    // SAFETY: row shapes are caller-declared, as they were for the synchronous
    // driver's generic all<T>(); the driver returns untyped records.
    return this.enqueue(() => this.db.prepare(sql).all(...params) as T[]);
  }

  async get<T = MetadataRow>(
    sql: string,
    ...params: MetadataParam[]
  ): Promise<T | undefined> {
    return this.enqueue(
      // SAFETY: row shape is caller-declared, as above.
      () => this.db.prepare(sql).get(...params) as T | undefined,
    );
  }

  async run(
    sql: string,
    ...params: MetadataParam[]
  ): Promise<{ changes: number }> {
    return this.enqueue(() => ({
      changes: Number(this.db.prepare(sql).run(...params).changes),
    }));
  }

  async exec(sql: string): Promise<void> {
    return this.enqueue(() => this.db.exec(sql));
  }

  async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.tx.getStore()) return fn();

    return this.enqueue(async () => {
      await this.withBusyRetry(() => this.db.exec("BEGIN IMMEDIATE"));

      try {
        const result = await this.tx.run(true, fn);
        this.db.exec("COMMIT");

        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async dataVersion(): Promise<number> {
    return this.enqueue(() =>
      Number(this.db.prepare("PRAGMA data_version").get()!.data_version),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    this.db.close();
  }
}

/** Preserve preview headless IDs, history and resources; leave originals as backups. */
export async function importHeadlessStore(
  home: string,
  source: string,
  lockOptions: Parameters<typeof withFileLock>[1],
) {
  try {
    await access(source);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }

  const database = new DatabaseSync(path.join(home, "review-api.db"), {
    timeout: 5000,
  });

  try {
    database.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS headless_imports(path TEXT PRIMARY KEY)",
    );

    if (
      database
        .prepare("SELECT 1 FROM headless_imports WHERE path=?")
        .get(source)
    )
      return;

    initializeReviewStoreSchema(database);

    const outcome = await withFileLock(
      path.join(path.dirname(source), "server.lock"),
      { ...lockOptions, timeoutMs: 0 },
      async () => {
        database.prepare("ATTACH DATABASE ? AS headless").run(source);
        database.exec("BEGIN IMMEDIATE");

        try {
          if (
            database
              .prepare(
                "SELECT 1 FROM headless.reviews s JOIN reviews t ON s.id=t.id LIMIT 1",
              )
              .get()
          )
            throw new Error(
              `Cannot merge ${source}: the shared store already contains one of its review IDs. Both databases are unchanged.`,
            );
          database.exec(`
          INSERT INTO repositories SELECT s.* FROM headless.repositories s WHERE NOT EXISTS (SELECT 1 FROM repositories t WHERE t.path=s.path);
          CREATE TEMP TABLE repository_ids AS SELECT s.id old_id,t.id new_id FROM headless.repositories s JOIN repositories t ON s.path=t.path;
        `);

          if (
            database
              .prepare(
                `SELECT 1 FROM headless.versions s LEFT JOIN repository_ids r ON json_extract(s.snapshot,'$.pins.repositoryId')=r.old_id WHERE r.old_id IS NULL LIMIT 1`,
              )
              .get()
          )
            throw new Error(
              `Cannot merge ${source}: a version refers to an unregistered repository. Both databases are unchanged.`,
            );

          if (
            database
              .prepare(`SELECT 1 FROM headless.resources s JOIN resources t ON s.id=t.id JOIN repository_ids r ON s.repository_id=r.old_id
          WHERE t.repository_id!=r.new_id OR t.kind!=s.kind OR t.mime_type!=s.mime_type OR t.data IS NOT s.data LIMIT 1`)
              .get()
          )
            throw new Error(
              `Cannot merge ${source}: a resource ID has different content. Both databases are unchanged.`,
            );

          database.exec(`
          INSERT OR IGNORE INTO resources SELECT s.id,r.new_id,s.kind,s.mime_type,s.data FROM headless.resources s JOIN repository_ids r ON s.repository_id=r.old_id;
          INSERT INTO reviews SELECT * FROM headless.reviews;
          INSERT INTO versions SELECT s.review_id,s.version,
            CASE WHEN json_type(s.snapshot,'$.target')='object'
              THEN json_set(s.snapshot,'$.pins.repositoryId',r.new_id,'$.target.repositoryId',r.new_id)
              ELSE json_set(s.snapshot,'$.pins.repositoryId',r.new_id) END
            FROM headless.versions s JOIN repository_ids r ON json_extract(s.snapshot,'$.pins.repositoryId')=r.old_id;
          INSERT INTO review_attention SELECT * FROM headless.review_attention;
        `);

          database
            .prepare("INSERT INTO headless_imports VALUES(?)")
            .run(source);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
    );

    if (!outcome.acquired)
      throw new Error(
        `Stop the old headless server using ${path.dirname(source)}, then retry. Its reviews will be moved into the shared profile automatically.`,
      );
  } finally {
    database.close();
  }
}

/** The original schema initializer, kept for the headless import's fresh
 * databases. REVIEW_SCHEMA above carries the same tables plus the ones other
 * classes added on top. */
function initializeReviewStoreSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, version INTEGER NOT NULL, next_id INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS versions(review_id TEXT REFERENCES reviews(id), version INTEGER, snapshot TEXT NOT NULL,
      PRIMARY KEY(review_id,version));
    CREATE TABLE IF NOT EXISTS review_attention(review_id TEXT PRIMARY KEY REFERENCES reviews(id), viewed_at TEXT, dismissed_at TEXT);
    CREATE TABLE IF NOT EXISTS repositories(id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id),
      kind TEXT NOT NULL, mime_type TEXT NOT NULL, data BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS review_coverage(review_id TEXT REFERENCES reviews(id), file TEXT, fingerprint TEXT NOT NULL, coverage TEXT NOT NULL,
      PRIMARY KEY(review_id,file));
    CREATE TABLE IF NOT EXISTS comparison_stats(identity TEXT PRIMARY KEY, stats TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS server_identity(one INTEGER PRIMARY KEY CHECK(one=1), id TEXT NOT NULL);
  `);
}
