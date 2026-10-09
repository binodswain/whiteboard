import { createHash, randomUUID } from "node:crypto";

import type {
  MetadataColumn,
  MetadataRow,
  MetadataStore,
} from "@review/review-api/storage/metadata-store.js";
import { z } from "zod";

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
  submitterId?: string;
  status: JobStatus;
  attempts: number;
  reviewId?: string;
  url?: string;
  error?: string;
};

export type JobResult = { reviewId: string; url?: string };

export interface JobRunner {
  submit(input: PrepareReviewInput, submitterId?: string): Promise<JobRecord>;
  get(jobId: string): Promise<JobRecord | undefined>;
  runNext(): Promise<boolean>;
  run(jobId: string): Promise<boolean>;
}

export type PrepareReview = (
  input: PrepareReviewInput,
  context: { jobId: string; submitterId?: string },
) => Promise<JobResult>;

const prepareReviewInputSchema = z.strictObject({
  repo: z.string().min(1),
  baseSha: z.string().min(1),
  headSha: z.string().min(1),
});

const jobStatusSchema = z.enum(["pending", "running", "succeeded", "failed"]);

type JobSqlRow = MetadataRow & {
  id: string;
  input: string;
  status: string;
  attempts: MetadataColumn;
  review_id: MetadataColumn;
  url: MetadataColumn;
  error: MetadataColumn;
  submitter_id: MetadataColumn;
};

function record(row: JobSqlRow): JobRecord {
  const result: JobRecord = {
    id: String(row.id),
    type: "prepare_review",
    input: prepareReviewInputSchema.parse(JSON.parse(row.input)),
    status: jobStatusSchema.parse(row.status),
    attempts: Number(row.attempts),
  };

  if (row.submitter_id) result.submitterId = String(row.submitter_id);

  if (row.review_id) result.reviewId = String(row.review_id);

  if (row.url) result.url = String(row.url);

  if (row.error) result.error = String(row.error);

  return result;
}

export function createQueueJobRunner(
  store: MetadataStore,
  prepare: PrepareReview,
  options: { leaseMs?: number; maxAttempts?: number } = {},
): JobRunner {
  const leaseMs = options.leaseMs ?? 60_000;
  const maxAttempts = options.maxAttempts ?? 3;

  const runJob = async (jobId?: string) => {
    const claimed: (JobSqlRow & { attempts: number }) | undefined =
      await store.transaction(async () => {
        const now = Date.now();

        const row = jobId
          ? await store.get<JobSqlRow>(
              `SELECT * FROM jobs_jobs WHERE (status='pending' OR (status='running' AND lease_until < ?)) AND id=? ORDER BY created_at LIMIT 1`,
              now,
              jobId,
            )
          : await store.get<JobSqlRow>(
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

    const heartbeat = setInterval(
      () => {
        void store
          .run(
            "UPDATE jobs_jobs SET lease_until=?,updated_at=? WHERE id=? AND status='running' AND attempts=?",
            Date.now() + leaseMs,
            new Date().toISOString(),
            String(claimed.id),
            claimed.attempts,
          )
          .catch(() => {});
      },
      Math.max(1, Math.floor(leaseMs / 3)),
    );

    heartbeat.unref();

    try {
      const output = await prepare(
        prepareReviewInputSchema.parse(JSON.parse(claimed.input)),
        {
          jobId: String(claimed.id),
          submitterId: claimed.submitter_id
            ? String(claimed.submitter_id)
            : undefined,
        },
      );

      await store.run(
        "UPDATE jobs_jobs SET status='succeeded',review_id=?,url=?,lease_until=NULL,error=NULL,updated_at=? WHERE id=? AND status='running' AND attempts=?",
        output.reviewId,
        output.url ?? null,
        new Date().toISOString(),
        String(claimed.id),
        claimed.attempts,
      );
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      const failed = Number(claimed.attempts) >= maxAttempts;
      await store.run(
        "UPDATE jobs_jobs SET status=?,lease_until=NULL,error=?,updated_at=? WHERE id=? AND status='running' AND attempts=?",
        failed ? "failed" : "pending",
        error,
        new Date().toISOString(),
        String(claimed.id),
        claimed.attempts,
      );
    } finally {
      clearInterval(heartbeat);
    }

    return true;
  };

  return {
    async submit(input, submitterId) {
      const key = createHash("sha256")
        .update(JSON.stringify({ input, submitterId: submitterId ?? null }))
        .digest("hex");

      const now = new Date().toISOString();
      const id = randomUUID();
      await store.run(
        `INSERT INTO jobs_jobs(id,job_key,type,input,status,attempts,submitter_id,created_at,updated_at)
         VALUES(?,?, 'prepare_review', ?, 'pending', 0, ?, ?, ?) ON CONFLICT(job_key) DO NOTHING`,
        id,
        key,
        JSON.stringify(input),
        submitterId ?? null,
        now,
        now,
      );

      await store.run(
        "UPDATE jobs_jobs SET status='pending',attempts=0,lease_until=NULL,review_id=NULL,url=NULL,error=NULL,submitter_id=?,updated_at=? WHERE job_key=? AND status='failed'",
        submitterId ?? null,
        now,
        key,
      );

      const row = await store.get<JobSqlRow>(
        "SELECT * FROM jobs_jobs WHERE job_key=?",
        key,
      );

      if (!row) throw new Error("Unable to persist review job.");

      return record(row);
    },
    async get(jobId) {
      const row = await store.get<JobSqlRow>(
        "SELECT * FROM jobs_jobs WHERE id=?",
        jobId,
      );

      return row ? record(row) : undefined;
    },
    runNext: () => runJob(),
    run: runJob,
  };
}

export function createInlineJobRunner(
  store: MetadataStore,
  prepare: PrepareReview,
  options: { leaseMs?: number; maxAttempts?: number; waitMs?: number } = {},
): JobRunner {
  const queue = createQueueJobRunner(store, prepare, options);
  const waitMs = options.waitMs ?? 30_000;

  return {
    async submit(input, submitterId) {
      const job = await queue.submit(input, submitterId);

      if (job.status === "pending" || job.status === "running") {
        let current = job;
        const deadline = Date.now() + waitMs;
        let delayMs = 50;

        while (
          (current.status === "pending" || current.status === "running") &&
          Date.now() < deadline
        ) {
          const ran = await queue.run(job.id);
          current = (await queue.get(job.id)) ?? current;

          if (!ran || current.status === "running") {
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(delayMs, deadline - Date.now())),
            );
            delayMs = Math.min(delayMs * 2, 250);
          }
        }

        return current;
      }

      return job;
    },
    get: (id) => queue.get(id),
    runNext: () => queue.runNext(),
    run: (id) => queue.run(id),
  };
}
