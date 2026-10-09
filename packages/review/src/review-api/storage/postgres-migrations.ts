/** Versioned migrations, applied in order inside one transaction each. v1 is
 * the Postgres equivalent of the SQLite schema in `sqlite.ts`: same tables
 * and constraints, with `rowid` made explicit where queries order by it and
 * millisecond timestamps widened to BIGINT. */
export const POSTGRES_MIGRATIONS: {
  version: number;
  name: string;
  sql: string;
}[] = [
  {
    version: 1,
    name: "initial",
    sql: `
      CREATE TABLE reviews(rowid BIGINT GENERATED ALWAYS AS IDENTITY,
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, next_id INTEGER NOT NULL);
      CREATE TABLE versions(review_id TEXT REFERENCES reviews(id), version INTEGER, snapshot TEXT NOT NULL,
        PRIMARY KEY(review_id,version));
      CREATE TABLE review_attention(review_id TEXT PRIMARY KEY REFERENCES reviews(id), viewed_at TEXT, dismissed_at TEXT);
      CREATE TABLE repositories(rowid BIGINT GENERATED ALWAYS AS IDENTITY,
        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
      CREATE TABLE resources(id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id),
        kind TEXT NOT NULL, mime_type TEXT NOT NULL, data BYTEA NOT NULL);
      CREATE TABLE review_coverage(review_id TEXT REFERENCES reviews(id), file TEXT, fingerprint TEXT NOT NULL, coverage TEXT NOT NULL,
        PRIMARY KEY(review_id,file));
      CREATE TABLE comparison_stats(identity TEXT PRIMARY KEY, stats TEXT NOT NULL);
      CREATE TABLE server_identity(one INTEGER PRIMARY KEY CHECK(one=1), id TEXT NOT NULL);
      CREATE TABLE authoring_presences(rowid BIGINT GENERATED ALWAYS AS IDENTITY,
        activity_id TEXT PRIMARY KEY, review_id TEXT NOT NULL, slot INTEGER NOT NULL,
        started_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, focus TEXT, surface TEXT);
      CREATE TABLE ask_conversations(
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
      CREATE INDEX ask_conversations_review ON ask_conversations(review_id, updated_at);
      CREATE TABLE ask_agent_offers(agent TEXT PRIMARY KEY, offer TEXT NOT NULL);
      CREATE TABLE ask_agent_model_offers(agent TEXT NOT NULL, model TEXT NOT NULL, offer TEXT NOT NULL, PRIMARY KEY(agent, model));
      CREATE TABLE headless_imports(path TEXT PRIMARY KEY);
      CREATE TABLE pinned_environments(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE workspace_leases(review_id TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL);`,
  },
  {
    version: 2,
    name: "review_jobs",
    sql: `CREATE TABLE jobs_jobs(
      id TEXT PRIMARY KEY, job_key TEXT NOT NULL UNIQUE, type TEXT NOT NULL, input TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_until BIGINT,
      review_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX jobs_jobs_claim ON jobs_jobs(status, lease_until, created_at);`,
  },
];
