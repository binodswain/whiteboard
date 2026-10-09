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
    // The issue number keeps the version unique while sibling hosted-mode
    // work adds its own migrations.
    version: 43,
    name: "auth",
    sql: `
      CREATE TABLE auth_users(
        id TEXT PRIMARY KEY, login TEXT NOT NULL, name TEXT, avatar_url TEXT,
        github_token TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE auth_sessions(
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id),
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
      CREATE TABLE auth_api_tokens(
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id),
        name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, last_used_at TEXT);
      CREATE TABLE auth_repo_access(
        user_id TEXT NOT NULL REFERENCES auth_users(id), repo TEXT NOT NULL,
        allowed INTEGER NOT NULL, checked_at TEXT NOT NULL,
        PRIMARY KEY(user_id, repo));`,
  },
];
