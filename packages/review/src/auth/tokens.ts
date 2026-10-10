import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { MetadataStore } from "@review/review-api/storage/metadata-store.js";

/** Every personal API token carries this prefix so a request's credential is
 * recognisably a user token, never a session or a server token. */
export const API_TOKEN_PREFIX = "wbt_";

export interface ApiTokenRecord {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * Personal API tokens for CLI/MCP access, stored hashed — the value is shown
 * once at creation and never again. Revocation deletes the row, so a revoked
 * token fails on its very next request.
 */
export function createApiTokens(meta: MetadataStore) {
  const hash = (token: string) =>
    createHash("sha256").update(`whiteboard:api-token:${token}`).digest("hex");

  return {
    /** Mint a token; the returned `token` is the only time it is readable. */
    async create(userId: string, name: string) {
      const token = `${API_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
      const id = randomUUID();
      const createdAt = new Date().toISOString();

      await meta.run(
        "INSERT INTO auth_api_tokens(id,user_id,name,token_hash,created_at) VALUES(?,?,?,?,?)",
        id,
        userId,
        name,
        hash(token),
        createdAt,
      );

      return { id, name, token, createdAt };
    },

    /** The owning user's id when the token is live, else null. */
    async authenticate(token: string): Promise<string | null> {
      if (!token.startsWith(API_TOKEN_PREFIX)) return null;

      const hashed = hash(token);

      const row = await meta.get(
        "SELECT user_id FROM auth_api_tokens WHERE token_hash=?",
        hashed,
      );

      if (!row) return null;

      void meta
        .run(
          "UPDATE auth_api_tokens SET last_used_at=? WHERE token_hash=?",
          new Date().toISOString(),
          hashed,
        )
        .catch(() => {});

      return String(row.user_id);
    },

    async list(userId: string): Promise<ApiTokenRecord[]> {
      const rows = await meta.all(
        `SELECT id,name,created_at,last_used_at FROM auth_api_tokens
         WHERE user_id=? ORDER BY created_at`,
        userId,
      );

      return rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        createdAt: String(row.created_at),
        lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
      }));
    },

    /** Revokes one of the user's own tokens; whether one existed. */
    async revoke(userId: string, id: string): Promise<boolean> {
      const { changes } = await meta.run(
        "DELETE FROM auth_api_tokens WHERE id=? AND user_id=?",
        id,
        userId,
      );

      return changes > 0;
    },
  };
}

export type ApiTokens = ReturnType<typeof createApiTokens>;
