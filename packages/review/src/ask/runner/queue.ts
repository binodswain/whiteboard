import { randomUUID } from "node:crypto";

import type { MetadataStore } from "@review/review-api/storage/metadata-store.js";

export type AskStatus = "pending" | "running" | "done" | "failed";

export interface QueuedAsk {
  id: string;
  reviewId: string;
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

const columns = `id, review_id AS "reviewId", prompt, status,
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
    prompt: string;
    createdBy: string;
    maxAttempts?: number;
    now?: number;
  }): Promise<string> {
    const id = randomUUID();
    const now = input.now ?? Date.now();
    await this.store.run(
      `INSERT INTO asks(id,review_id,prompt,status,attempts,max_attempts,created_by,created_at,updated_at)
       VALUES(?,?,?,'pending',0,?,?,?,?)`,
      id,
      input.reviewId,
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

  async pending(limit = 20): Promise<QueuedAsk[]> {
    const rows = await this.store.all<AskRow>(
      `SELECT ${columns} FROM asks WHERE status='pending' ORDER BY created_at LIMIT ?`,
      limit,
    );

    return rows.map((row) => mapAsk(row)!);
  }

  async claim(
    id: string,
    runnerId: string,
    options: { now?: number; leaseMs?: number } = {},
  ): Promise<QueuedAsk | undefined> {
    const now = options.now ?? Date.now();

    return this.store.transaction(async () => {
      await this.reapExpired(now);

      const result = await this.store.run(
        `UPDATE asks SET status='running', claimed_by=?, lease_until=?, attempts=attempts+1, updated_at=?
         WHERE id=? AND status='pending'`,
        runnerId,
        now + (options.leaseMs ?? 10 * 60_000),
        now,
        id,
      );

      return result.changes === 1 ? this.get(id) : undefined;
    });
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
         claimed_by=NULL, lease_until=NULL,
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
      `UPDATE asks SET status='done', result_refs=?, claimed_by=NULL, lease_until=NULL, updated_at=?
       WHERE id=? AND status='running' AND claimed_by=?`,
      JSON.stringify(resultRefs),
      Date.now(),
      id,
      runnerId,
    );

    return result.changes === 1;
  }

  async fail(id: string, runnerId: string, error: string): Promise<boolean> {
    const result = await this.store.run(
      `UPDATE asks SET status='failed', error=?, claimed_by=NULL, lease_until=NULL, updated_at=?
       WHERE id=? AND status='running' AND claimed_by=?`,
      error,
      Date.now(),
      id,
      runnerId,
    );

    return result.changes === 1;
  }
}
