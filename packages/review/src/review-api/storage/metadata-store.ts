/** A bind parameter. The adapters share SQLite's `?` placeholder spelling;
 * the Postgres adapter rewrites it as `$1..$n` before sending. */
export type MetadataParam = string | number | bigint | null | Uint8Array;

export type MetadataRow = Record<string, MetadataColumn>;

/** A column value as the drivers return it: the SQL scalar types this schema
 * uses (JSON and timestamps are stored as TEXT, binary as BLOB/BYTEA). */
export type MetadataColumn =
  | string
  | number
  | bigint
  | boolean
  | null
  | Uint8Array;

/** SQL fragments that differ per backend. Queries are written once against
 * this vocabulary so each adapter keeps its own dialect. */
export interface MetadataDialect {
  /** A nested JSON value as SQL text or scalar: path segments joined by `.`.
   * Reads as text on Postgres and as the JSON value's own type on SQLite, so
   * comparisons must stay string-typed. */
  jsonText(column: string, path: string): string;
  /** The JSON document with one top-level key removed, as text. */
  jsonWithout(column: string, key: string): string;
  /** Complete boolean predicate: the JSON flag at `path` is set. Missing and
   * falsy values count as unset. */
  jsonFlag(column: string, path: string): string;
  /** Substring test on the column's raw text against the next `?` param. */
  containsText(column: string): string;
}

/** The async boundary between the review API and its metadata backend.
 * Statement order is preserved per store; transactions serialize writers so
 * a second connection sees the same single-writer behaviour SQLite gives one
 * `BEGIN IMMEDIATE`. */
export interface MetadataStore {
  readonly kind: "sqlite" | "postgres";
  readonly dialect: MetadataDialect;
  /** All matching rows for a SELECT. */
  all<T = MetadataRow>(sql: string, ...params: MetadataParam[]): Promise<T[]>;
  /** The first matching row, when there is one. */
  get<T = MetadataRow>(
    sql: string,
    ...params: MetadataParam[]
  ): Promise<T | undefined>;
  /** A statement for its effect; resolves with the changed-row count. */
  run(sql: string, ...params: MetadataParam[]): Promise<{ changes: number }>;
  /** One or more statements for their effect only (DDL, PRAGMAs). */
  exec(sql: string): Promise<void>;
  /** `fn` runs inside an immediate write transaction; on error the whole
   * transaction rolls back. Calls made through this store while `fn` runs
   * join the transaction. A nested `transaction` call joins the outer one. */
  transaction<T>(fn: () => Promise<T> | T): Promise<T>;
  /** A value that changes when another client commits writes; used only to
   * decide when a poller should re-read, never as data. */
  dataVersion(): Promise<number>;
  close(): Promise<void>;
}

export type MetadataStoreConfig =
  | {
      kind: "sqlite";
      /** The database file path, or ":memory:". */
      dir: string;
      /** Open an existing file read-only; skips schema initialization. */
      readonly?: boolean;
      /** The sidecar workspace database carries only its own two tables;
       * the review database is the default. */
      schema?: "review" | "workspace";
    }
  | {
      kind: "postgres";
      /** A postgres:// connection URL. */
      url: string;
      /** Pool size; sized for a single replica's concurrency. Default 10. */
      poolSize?: number;
    };

/** The default backend is SQLite; Postgres is selected by config. */
export async function createMetadataStore(
  config: MetadataStoreConfig,
): Promise<MetadataStore> {
  if (config.kind === "postgres") {
    const { PostgresMetadataStore } = await import("./postgres.js");

    return PostgresMetadataStore.open(config);
  }

  const { SqliteMetadataStore } = await import("./sqlite.js");

  return SqliteMetadataStore.open(config);
}

/** Open functions take a file path or an already-open store; the path stays a
 * primitive so `dialect` — present on every adapter — discriminates it. */
export function isMetadataStore(
  source: string | MetadataStore,
): source is MetadataStore {
  return source instanceof Object && "dialect" in source;
}
