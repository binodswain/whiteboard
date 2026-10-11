import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { MetadataStore } from "@review/review-api/storage/metadata-store.js";

export type AskStatus = "pending" | "running" | "done" | "failed";

/** Who an ask is for: a person's question from the board, or an unattended
 * pull request review that only a locked-down runner should take. */
export const askKinds = ["interactive", "pr-review"] as const;

export type AskKind = (typeof askKinds)[number];

/** Every per-ask token carries this prefix, so a request's credential is
 * recognisably one bound to a single claimed ask. */
export const ASK_TOKEN_PREFIX = "wba_";

const hashAskToken = (token: string) =>
  createHash("sha256").update(`whiteboard:ask-token:${token}`).digest("hex");

export interface QueuedAsk {
  id: string;
  reviewId: string;
  kind: AskKind;
  prompt: string;
  status: AskStatus;
  claimedBy: string | null;
  leaseUntil: number | null;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  createdBy: string;
  resultRefs: string[];
  createdAt: number;
  updatedAt: number;
}

type AskRow = Omit<QueuedAsk, "resultRefs"> & { result_refs: string | null };

const columns = `id, review_id AS "reviewId", kind, prompt, status,
  claimed_by AS "claimedBy", lease_until AS "leaseUntil", attempts,
  max_attempts AS "maxAttempts", error, created_by AS "createdBy",
  result_refs, created_at AS "createdAt", updated_at AS "updatedAt"`;

function mapAsk(row: AskRow | undefined): QueuedAsk | undefined {
  if (!row) return undefined;

  return {
    ...row,
    resultRefs: row.result_refs ? JSON.parse(row.result_refs) : [],
  };
}

export class AskQueue {
  constructor(private readonly store: MetadataStore) {}

  async create(input: {
    reviewId: string;
    kind?: AskKind;
    prompt: string;
    createdBy: string;
    maxAttempts?: number;
    now?: number;
  }): Promise<string> {
    const id = randomUUID();
    const now = input.now ?? Date.now();
    await this.store.run(
      `INSERT INTO asks(id,review_id,kind,prompt,status,attempts,max_attempts,created_by,created_at,updated_at)
       VALUES(?,?,?,?,'pending',0,?,?,?,?)`,
      id,
      input.reviewId,
      input.kind ?? "interactive",
      input.prompt,
      input.maxAttempts ?? 5,
      input.createdBy,
      now,
      now,
    );

    return id;
  }

  async get(id: string): Promise<QueuedAsk | undefined> {
    return mapAsk(
      await this.store.get<AskRow>(
        `SELECT ${columns} FROM asks WHERE id=?`,
        id,
      ),
    );
  }

  async pending(
    options: { kind?: AskKind; limit?: number } = {},
  ): Promise<QueuedAsk[]> {
    const rows = options.kind
      ? await this.store.all<AskRow>(
          `SELECT ${columns} FROM asks WHERE status='pending' AND kind=? ORDER BY created_at LIMIT ?`,
          options.kind,
          options.limit ?? 20,
        )
      : await this.store.all<AskRow>(
          `SELECT ${columns} FROM asks WHERE status='pending' ORDER BY created_at LIMIT ?`,
          options.limit ?? 20,
        );

    return rows.map((row) => mapAsk(row)!);
  }

  /** Claims a pending ask and mints the one token its agent may use: it
   * reaches only this ask's review, and only while this claim's lease lives. */
  async claim(
    id: string,
    runnerId: string,
    options: { now?: number; leaseMs?: number } = {},
  ): Promise<{ ask: QueuedAsk; token: string } | undefined> {
    const now = options.now ?? Date.now();
    const token = `${ASK_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;

    return this.store.transaction(async () => {
      await this.reapExpired(now);

      const result = await this.store.run(
        `UPDATE asks SET status='running', claimed_by=?, lease_until=?, attempts=attempts+1, token_hash=?, updated_at=?
         WHERE id=? AND status='pending'`,
        runnerId,
        now + (options.leaseMs ?? 2 * 60_000),
        hashAskToken(token),
        now,
        id,
      );

      if (result.changes !== 1) return undefined;
      const ask = await this.get(id);

      return ask && { ask, token };
    });
  }

  /** The ask and review a per-ask token is bound to, while its claim is live. */
  async authenticateToken(
    token: string,
    now = Date.now(),
  ): Promise<{ askId: string; reviewId: string } | undefined> {
    if (!token.startsWith(ASK_TOKEN_PREFIX)) return undefined;

    return this.store.get<{ askId: string; reviewId: string }>(
      `SELECT id AS "askId", review_id AS "reviewId" FROM asks
       WHERE token_hash=? AND status='running' AND lease_until>?`,
      hashAskToken(token),
      now,
    );
  }

  async heartbeat(
    id: string,
    runnerId: string,
    options: { now?: number; leaseMs?: number } = {},
  ): Promise<boolean> {
    const now = options.now ?? Date.now();

    const result = await this.store.run(
      `UPDATE asks SET lease_until=?, updated_at=?
       WHERE id=? AND status='running' AND claimed_by=?`,
      now + (options.leaseMs ?? 2 * 60_000),
      now,
      id,
      runnerId,
    );

    return result.changes === 1;
  }

  async reapExpired(now = Date.now()): Promise<number> {
    return this.store.transaction(async () => {
      const expired = await this.store.all<{ id: string }>(
        "SELECT id FROM asks WHERE status='running' AND lease_until<=?",
        now,
      );

      if (!expired.length) return 0;
      await this.store.run(
        `UPDATE asks SET status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,
         claimed_by=NULL, lease_until=NULL, token_hash=NULL,
         error=CASE WHEN attempts>=max_attempts THEN 'Runner lease expired after maximum attempts' ELSE error END,
         updated_at=? WHERE status='running' AND lease_until<=?`,
        now,
        now,
      );

      return expired.length;
    });
  }

  async complete(
    id: string,
    runnerId: string,
    resultRefs: string[],
  ): Promise<boolean> {
    const result = await this.store.run(
      `UPDATE asks SET status='done', result_refs=?, claimed_by=NULL, lease_until=NULL, token_hash=NULL, updated_at=?
       WHERE id=? AND status='running' AND claimed_by=?`,
      JSON.stringify(resultRefs),
      Date.now(),
      id,
      runnerId,
    );

    return result.changes === 1;
  }

  /** Stops an ask nobody should run any more; a runner holding it loses its
   * lease and can no longer complete it. */
  async cancel(id: string): Promise<boolean> {
    const result = await this.store.run(
      `UPDATE asks SET status='failed', error='Cancelled', claimed_by=NULL, lease_until=NULL, token_hash=NULL, updated_at=?
       WHERE id=? AND status IN ('pending','running')`,
      Date.now(),
      id,
    );

    return result.changes === 1;
  }

  async fail(id: string, runnerId: string, error: string): Promise<boolean> {
    const result = await this.store.run(
      `UPDATE asks SET status='failed', error=?, claimed_by=NULL, lease_until=NULL, token_hash=NULL, updated_at=?
       WHERE id=? AND status='running' AND claimed_by=?`,
      error,
      Date.now(),
      id,
      runnerId,
    );

    return result.changes === 1;
  }
}
