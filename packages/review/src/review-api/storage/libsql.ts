import { AsyncLocalStorage } from "node:async_hooks";

import {
  type Client,
  type InStatement,
  type Transaction,
  createClient,
} from "@libsql/client";

import type {
  MetadataParam,
  MetadataRow,
  MetadataStore,
  MetadataStoreConfig,
} from "./metadata-store.js";
import {
  REVIEW_COLUMNS,
  REVIEW_SCHEMA,
  SQLITE_DIALECT,
  WORKSPACE_SCHEMA,
} from "./sqlite.js";

/** Remote busy/lock errors arrive as LibsqlError (SERVER_ERROR on HTTP,
 * SQLITE_BUSY on file:); either way the message names the cause. */
const isBusy = (cause: unknown) =>
  cause instanceof Error &&
  (/locked/i.test(cause.message) ||
    /busy/i.test(cause.message) ||
    // SAFETY: LibsqlError carries a `code` field; the optional read is the only
    // use and plain Errors fail the test harmlessly.
    (cause as { code?: string }).code === "SQLITE_BUSY");

/** `PRAGMA data_version` only sees the local connection and Postgres reads
 * `xact_commit`; a remote libSQL database has neither, so every commit bumps
 * this row instead. */
const DATA_VERSION = {
  init: `CREATE TABLE IF NOT EXISTS metadata_data_version(one INTEGER PRIMARY KEY CHECK(one=1), value INTEGER NOT NULL);
    INSERT OR IGNORE INTO metadata_data_version VALUES(1,0);`,
  bump: {
    sql: "UPDATE metadata_data_version SET value=value+1 WHERE one=1",
  } satisfies InStatement,
  read: "SELECT value FROM metadata_data_version WHERE one=1",
};

/**
 * Remote SQLite over libSQL (Turso, sqld, or a `file:` path). Writes queue
 * locally like the SQLite adapter and retry on server-side busy like
 * `BEGIN IMMEDIATE` contention; remote commits bump `metadata_data_version`
 * so `dataVersion()` stays a cross-client poll gate.
 */
export class LibsqlMetadataStore implements MetadataStore {
  readonly kind = "libsql";
  readonly dialect = SQLITE_DIALECT;
  private readonly tx = new AsyncLocalStorage<Transaction>();
  private writeQueue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly client: Client,
    private readonly schema: "review" | "workspace",
  ) {}

  static async open(
    config: Extract<MetadataStoreConfig, { kind: "libsql" }>,
  ): Promise<LibsqlMetadataStore> {
    const store = new LibsqlMetadataStore(
      createClient({
        url: config.url,
        authToken: config.authToken,
      }),
      config.schema ?? "review",
    );

    await store.initialize();

    return store;
  }

  /** Mirrors `SqliteMetadataStore.initialize`, over one write transaction;
   * retried on busy so replicas racing the same schema don't crash on boot. */
  private async initialize() {
    await this.withBusyRetry(async () => {
      const tx = await this.client.transaction("write");

      try {
        await tx.executeMultiple(
          `${DATA_VERSION.init}\n${this.schema === "workspace" ? WORKSPACE_SCHEMA : REVIEW_SCHEMA}`,
        );

        if (this.schema === "review") {
          const columnsOf = async (table: string) =>
            new Set(
              (await tx.execute(`PRAGMA table_info(${table})`)).rows.map(
                (column) => String(column.name),
              ),
            );

          // Columns added after first release, for databases created before them.
          if (!(await columnsOf("ask_conversations")).has("bypass"))
            await tx.execute(
              "ALTER TABLE ask_conversations ADD COLUMN bypass INTEGER NOT NULL DEFAULT 0",
            );

          if (!(await columnsOf("jobs_jobs")).has("url"))
            await tx.execute("ALTER TABLE jobs_jobs ADD COLUMN url TEXT");

          if (!(await columnsOf("jobs_jobs")).has("submitter_id"))
            await tx.execute(
              "ALTER TABLE jobs_jobs ADD COLUMN submitter_id TEXT",
            );

          const present = await columnsOf("reviews");

          const missing = REVIEW_COLUMNS.filter(
            (column) => !present.has(column),
          );

          if (missing.length) {
            for (const column of missing)
              await tx.execute(`ALTER TABLE reviews ADD COLUMN ${column} TEXT`);
            await tx.executeMultiple(`
              UPDATE reviews SET
                branch=(SELECT json_extract(versions.snapshot,'$.origin.branch') FROM versions WHERE versions.review_id=reviews.id AND versions.version=reviews.version),
                base_sha=(SELECT json_extract(versions.snapshot,'$.pins.base') FROM versions WHERE versions.review_id=reviews.id AND versions.version=reviews.version),
                head_sha=(SELECT json_extract(versions.snapshot,'$.pins.head') FROM versions WHERE versions.review_id=reviews.id AND versions.version=reviews.version),
                created_by=(SELECT json_extract(versions.snapshot,'$.createdBy') FROM versions WHERE versions.review_id=reviews.id AND versions.version=reviews.version);
              CREATE INDEX IF NOT EXISTS reviews_branch ON reviews(branch);
              CREATE INDEX IF NOT EXISTS reviews_created_by ON reviews(created_by);`);
          }
        }

        await tx.commit();
      } finally {
        tx.close();
      }
    });
  }

  private conn(): Pick<Client | Transaction, "execute"> {
    return this.tx.getStore() ?? this.client;
  }

  /** Write transactions run one at a time locally, matching the single
   * writer a SQLite file gives one process; busy retries cover commits
   * racing another replica. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error("The metadata store is closed."));

    const run = this.writeQueue.then(job);
    this.writeQueue = run.catch(() => {});

    return run;
  }

  private async withBusyRetry<T>(job: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 5000;

    for (;;) {
      try {
        return await job();
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
    const result = await this.withBusyRetry(() =>
      this.conn().execute({ sql, args: params }),
    );

    // SAFETY: row shapes are caller-declared, matching the other adapters.
    return result.rows as T[];
  }

  async get<T = MetadataRow>(
    sql: string,
    ...params: MetadataParam[]
  ): Promise<T | undefined> {
    const result = await this.withBusyRetry(() =>
      this.conn().execute({ sql, args: params }),
    );

    // SAFETY: row shape is caller-declared, as above.
    return result.rows[0] as T | undefined;
  }

  async run(
    sql: string,
    ...params: MetadataParam[]
  ): Promise<{ changes: number }> {
    if (this.tx.getStore()) {
      const result = await this.withBusyRetry(() =>
        this.conn().execute({ sql, args: params }),
      );

      return { changes: result.rowsAffected };
    }

    // Statement plus version bump as one atomic batch: a commit outside a
    // transaction still moves the version pollers watch.
    const [result] = await this.withBusyRetry(() =>
      this.client.batch([{ sql, args: params }, DATA_VERSION.bump], "write"),
    );

    return { changes: result?.rowsAffected ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    const activeTx = this.tx.getStore();

    if (activeTx) {
      await this.withBusyRetry(() => activeTx.executeMultiple(sql));

      return;
    }

    await this.enqueue(() =>
      this.withBusyRetry(async () => {
        const tx = await this.client.transaction("write");

        try {
          await tx.executeMultiple(sql);
          await tx.execute(DATA_VERSION.bump);
          await tx.commit();
        } finally {
          tx.close();
        }
      }),
    );
  }

  async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.tx.getStore()) return fn();

    return this.enqueue(() =>
      this.withBusyRetry(async () => {
        const tx = await this.client.transaction("write");

        try {
          const result = await this.tx.run(tx, fn);
          await tx.execute(DATA_VERSION.bump);
          await tx.commit();

          return result;
        } catch (error) {
          await tx.rollback().catch(() => {});
          throw error;
        } finally {
          tx.close();
        }
      }),
    );
  }

  async dataVersion(): Promise<number> {
    const row = await this.get<{ value: number | bigint }>(DATA_VERSION.read);

    return Number(row?.value ?? 0);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writeQueue;
    this.client.close();
  }
}
