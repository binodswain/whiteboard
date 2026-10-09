import { createHash, randomUUID } from "node:crypto";

import type { MetadataStore } from "@review/review-api/storage/metadata-store.js";

export type JobStatus = "pending" | "running" | "succeeded" | "failed";
export type PrepareReviewInput = {
  repo: string;
  baseSha: string;
  headSha: string;
};
export type JobRecord = {
  id: string;
  type: "prepare_review";
  input: PrepareReviewInput;
  status: JobStatus;
  attempts: number;
  reviewId?: string;
  error?: string;
};
export type JobResult = { reviewId: string; url?: string };

export interface JobRunner {
  submit(input: PrepareReviewInput): Promise<JobRecord>;
  get(jobId: string): Promise<JobRecord | undefined>;
  runNext(): Promise<boolean>;
}

export type PrepareReview = (input: PrepareReviewInput) => Promise<JobResult>;

function record(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    type: "prepare_review",
    input: JSON.parse(String(row.input)) as PrepareReviewInput,
    status: String(row.status) as JobStatus,
    attempts: Number(row.attempts),
    ...(row.review_id ? { reviewId: String(row.review_id) } : {}),
    ...(row.error ? { error: String(row.error) } : {}),
  };
}

export function createQueueJobRunner(
  store: MetadataStore,
  prepare: PrepareReview,
  options: { leaseMs?: number; maxAttempts?: number } = {},
): JobRunner {
  const leaseMs = options.leaseMs ?? 60_000;
  const maxAttempts = options.maxAttempts ?? 3;

  return {
    async submit(input) {
      const key = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
      const now = new Date().toISOString();
      const id = randomUUID();
      await store.run(
        `INSERT INTO jobs_jobs(id,job_key,type,input,status,attempts,created_at,updated_at)
         VALUES(?,?, 'prepare_review', ?, 'pending', 0, ?, ?) ON CONFLICT(job_key) DO NOTHING`,
        id,
        key,
        JSON.stringify(input),
        now,
        now,
      );
      const row = await store.get<Record<string, unknown>>(
        "SELECT * FROM jobs_jobs WHERE job_key=?",
        key,
      );
      if (!row) throw new Error("Unable to persist review job.");
      return record(row);
    },
    async get(jobId) {
      const row = await store.get<Record<string, unknown>>(
        "SELECT * FROM jobs_jobs WHERE id=?",
        jobId,
      );
      return row ? record(row) : undefined;
    },
    async runNext() {
      const claimed:
        | (Record<string, unknown> & { attempts: number })
        | undefined = await store.transaction(async () => {
        const now = Date.now();
        const row = await store.get<Record<string, unknown>>(
          `SELECT * FROM jobs_jobs WHERE status='pending' OR (status='running' AND lease_until < ?) ORDER BY created_at LIMIT 1`,
          now,
        );
        if (!row) return undefined;
        const attempts = Number(row.attempts) + 1;
        if (attempts > maxAttempts) {
          await store.run(
            "UPDATE jobs_jobs SET status='failed',error=?,lease_until=NULL,updated_at=? WHERE id=?",
            "Worker lease expired; retry limit reached.",
            new Date().toISOString(),
            String(row.id),
          );
          return undefined;
        }
        const result = await store.run(
          `UPDATE jobs_jobs SET status='running',attempts=?,lease_until=?,error=NULL,updated_at=? WHERE id=? AND (status='pending' OR lease_until < ?)`,
          attempts,
          now + leaseMs,
          new Date().toISOString(),
          String(row.id),
          now,
        );
        return result.changes ? { ...row, attempts } : undefined;
      });
      if (!claimed) return false;
      try {
        const output = await prepare(
          JSON.parse(String(claimed.input)) as PrepareReviewInput,
        );
        await store.run(
          "UPDATE jobs_jobs SET status='succeeded',review_id=?,lease_until=NULL,error=NULL,updated_at=? WHERE id=? AND status='running'",
          output.reviewId,
          new Date().toISOString(),
          String(claimed.id),
        );
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        const failed = Number(claimed.attempts) >= maxAttempts;
        await store.run(
          "UPDATE jobs_jobs SET status=?,lease_until=NULL,error=?,updated_at=? WHERE id=? AND status='running'",
          failed ? "failed" : "pending",
          error,
          new Date().toISOString(),
          String(claimed.id),
        );
      }
      return true;
    },
  };
}

export function createInlineJobRunner(
  store: MetadataStore,
  prepare: PrepareReview,
): JobRunner {
  const queue = createQueueJobRunner(store, prepare);
  return {
    async submit(input) {
      const job = await queue.submit(input);
      if (job.status === "pending" || job.status === "running") {
        await queue.runNext();
        return (await queue.get(job.id)) ?? job;
      }
      return job;
    },
    get: (id) => queue.get(id),
    runNext: () => queue.runNext(),
  };
}
