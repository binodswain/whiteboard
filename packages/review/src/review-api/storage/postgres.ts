import { AsyncLocalStorage } from "node:async_hooks";

import pg from "pg";

import type {
  MetadataDialect,
  MetadataParam,
  MetadataRow,
  MetadataStore,
  MetadataStoreConfig,
} from "./metadata-store.js";
import { POSTGRES_MIGRATIONS } from "./postgres-migrations.js";

const jsonPath = (path: string) => `{${path.split(".").join(",")}}`;

const POSTGRES_DIALECT: MetadataDialect = {
  jsonText: (column, path) => `(${column}::jsonb #>> '${jsonPath(path)}')`,
  jsonWithout: (column, key) => `(${column}::jsonb - '${key}')::text`,
  jsonFlag: (column, path) =>
    `COALESCE((${column}::jsonb #>> '${jsonPath(path)}'),'false') = 'true'`,
  containsText: (column) => `strpos(${column}, ?) > 0`,
};

/** SQLite `?` placeholders become Postgres `$1..$n`, skipping quoted text. */
function placeholders(sql: string): string {
  let out = "",
    quoted = false,
    index = 0;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]!;

    if (quoted) {
      out += char;

      if (char === "'") {
        if (sql[i + 1] === "'") out += sql[++i];
        else quoted = false;
      }

      continue;
    }

    if (char === "'") quoted = true;
    out += char === "?" ? `$${++index}` : char;
  }

  return out;
}

/** One shared write lock, matching `BEGIN IMMEDIATE`: every write
 * transaction queues here, so two replicas see the same single writer a
 * SQLite file gives one process. */
const WRITE_LOCK_KEY = 872_354_012;

export class PostgresMetadataStore implements MetadataStore {
  readonly kind = "postgres";
  readonly dialect = POSTGRES_DIALECT;
  private readonly pool: pg.Pool;
  private readonly tx = new AsyncLocalStorage<pg.PoolClient>();

  private constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  static async open(
    config: Extract<MetadataStoreConfig, { kind: "postgres" }>,
  ): Promise<PostgresMetadataStore> {
    const store = new PostgresMetadataStore(
      new pg.Pool({ connectionString: config.url, max: config.poolSize ?? 10 }),
    );

    await store.migrate();

    return store;
  }

  private async migrate() {
    await this.pool.query(
      "CREATE TABLE IF NOT EXISTS metadata_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );

    const { rows } = await this.pool.query<{ version: number }>(
      "SELECT version FROM metadata_migrations",
    );

    const applied = new Set(rows.map((row) => Number(row.version)));

    for (const migration of POSTGRES_MIGRATIONS) {
      if (applied.has(migration.version)) continue;

      const client = await this.pool.connect();

      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO metadata_migrations(version,name,applied_at) VALUES($1,$2,$3)",
          [migration.version, migration.name, new Date().toISOString()],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
  }

  private conn(): Pick<pg.Pool | pg.PoolClient, "query"> {
    return this.tx.getStore() ?? this.pool;
  }

  private static params(params: MetadataParam[]): unknown[] {
    return params.map((param) =>
      param instanceof Uint8Array ? Buffer.from(param) : param,
    );
  }

  async all<T = MetadataRow>(
    sql: string,
    ...params: MetadataParam[]
  ): Promise<T[]> {
    const result = await this.conn().query(
      placeholders(sql),
      PostgresMetadataStore.params(params),
    );

    // SAFETY: row shapes are caller-declared, matching the SQLite adapter's
    // generic all<T>(); pg returns untyped records.
    return result.rows as T[];
  }

  async get<T = MetadataRow>(
    sql: string,
    ...params: MetadataParam[]
  ): Promise<T | undefined> {
    const result = await this.conn().query(
      placeholders(sql),
      PostgresMetadataStore.params(params),
    );

    // SAFETY: row shape is caller-declared, as above.
    return result.rows[0] as T | undefined;
  }

  async run(
    sql: string,
    ...params: MetadataParam[]
  ): Promise<{ changes: number }> {
    const result = await this.conn().query(
      placeholders(sql),
      PostgresMetadataStore.params(params),
    );

    return { changes: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.conn().query(sql);
  }

  async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.tx.getStore()) return fn();

    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [WRITE_LOCK_KEY]);

      let result: T;

      try {
        result = await this.tx.run(client, fn);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }

      await client.query("COMMIT");

      return result;
    } finally {
      client.release();
    }
  }

  /** Commits to this database by any client; used only as a poll gate. */
  async dataVersion(): Promise<number> {
    const row = await this.get<{ xact_commit: string | number }>(
      "SELECT xact_commit FROM pg_stat_database WHERE datname=current_database()",
    );

    return Number(row?.xact_commit ?? 0);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
