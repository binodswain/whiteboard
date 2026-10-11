import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { JsonObject } from "@dev.fast/json";
import type { JobRunner } from "@review/jobs/job-runner.js";
import type { MetadataStore } from "@review/review-api/storage/metadata-store.js";
import { z } from "zod";

import type { CheckRunsClient } from "./github-checks.js";
import type { MergeBaseResolver } from "./github-compare.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** A dispatch that has not finished after this long is presumed dead. */
const DISPATCH_STALE_MS = 60_000;

const ACTIONS = new Set(["opened", "reopened", "synchronize"]);

const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;

const payloadSchema = z.object({
  action: z.string(),
  number: z.number().int().positive(),
  installation: z.object({ id: z.number().int().positive() }).optional(),
  repository: z.object({ full_name: z.string() }),
  pull_request: z.object({
    draft: z.boolean().optional(),
    base: z.object({ sha: z.string() }),
    head: z.object({
      sha: z.string(),
      repo: z.object({ full_name: z.string() }).nullable(),
    }),
  }),
});

export type PrReviewRunStatus =
  /** Row exists; the job is not submitted yet. */
  | "queued"
  /** One delivery owns the run while it creates the check and the job. */
  | "dispatching"
  /** The prepare_review job is submitted or running. */
  | "preparing"
  /** The review exists and its link is on the check. */
  | "prepared"
  | "failed"
  /** The PR cannot be reviewed (a fork); the check says so. */
  | "unsupported";

type RunRow = {
  id: string;
  installation_id: string;
  repo: string;
  pr_number: number;
  base_sha: string;
  head_sha: string;
  status: PrReviewRunStatus;
  job_id: string | null;
  review_id: string | null;
  review_url: string | null;
  check_run_id: string | null;
  superseded: number;
};

export interface PrReviews {
  /** Answers a `POST /integrations/github/webhook`. */
  handleWebhook(request: Request): Promise<Response>;
  /** Moves runs whose prepare job has finished to their terminal state. */
  reconcile(): Promise<void>;
}

function reply(status: number, body: JsonObject): Response {
  return Response.json(
    { ok: status < 400, ...body },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function signatureMatches(secret: string, body: Buffer, header: string | null) {
  if (!header?.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", secret).update(body).digest();
  const supplied = Buffer.from(header.slice("sha256=".length), "hex");

  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

/** The raw body, or undefined once it passes the cap. The stream is read
 * incrementally: this route is public and unsigned until the body is in, so
 * a missing or false Content-Length must not decide how much gets buffered. */
async function readBody(request: Request): Promise<Buffer | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES)
    return undefined;

  const reader = request.body?.getReader();

  if (!reader) return Buffer.alloc(0);

  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) break;

    total += value.byteLength;

    if (total > MAX_BODY_BYTES) {
      await reader.cancel();

      return undefined;
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

/**
 * Turns `pull_request` webhooks into one Whiteboard review job and one
 * check run per `(installation, repository, PR, head SHA)`.
 *
 * Everything a delivery can change is keyed by that tuple, so a redelivery
 * adds nothing, a retry of a failed run reuses its row, and a late result
 * for an old head can only touch that head's own check.
 */
export function createPrReviews(input: {
  config: {
    webhookSecret: string;
    repos: string[];
    drafts: boolean;
    /** Public origin of this deployment; check links are built from it. */
    publicUrl: string;
  };
  /** The App's single configured installation, when it has one. */
  installationId?: string;
  webUrl: string;
  meta: MetadataStore;
  jobs: JobRunner;
  checks: CheckRunsClient;
  mergeBase: MergeBaseResolver;
  log?: (message: string) => void;
}): PrReviews {
  const { meta, jobs, checks, config } = input;
  const log = input.log ?? (() => {});
  const webUrl = input.webUrl.replace(/\/$/, "");
  const publicUrl = config.publicUrl.replace(/\/$/, "");

  const now = () => new Date().toISOString();

  const getRun = (id: string) =>
    meta.get<RunRow>("SELECT * FROM pr_review_runs WHERE id=?", id);

  const setRun = (
    id: string,
    fields: Partial<Record<string, string | number | null>>,
    onlyFrom?: PrReviewRunStatus,
  ) => {
    const columns = Object.keys(fields);

    return meta.run(
      `UPDATE pr_review_runs SET ${columns.map((column) => `${column}=?`).join(",")},updated_at=? WHERE id=?${onlyFrom ? " AND status=?" : ""}`,
      ...columns.map((column) => fields[column] ?? null),
      now(),
      id,
      ...(onlyFrom ? [onlyFrom] : []),
    );
  };

  /** Creates the run's check once; a delivery that died after the row was
   * written but before the check was recorded finishes it here. */
  const ensureCheck = async (
    run: RunRow,
    output: { title: string; summary: string },
  ) => {
    if (run.check_run_id) return run.check_run_id;

    const checkRunId = await checks.create({
      repo: run.repo,
      headSha: run.head_sha,
      status: "queued",
      output,
    });

    await setRun(run.id, { check_run_id: checkRunId });

    return checkRunId;
  };

  /** Only one delivery gets to dispatch a run: the others, racing on the
   * same head, see it taken. A dispatch that died is retaken once stale. */
  const claim = async (run: RunRow) => {
    const claimed = await meta.run(
      `UPDATE pr_review_runs SET status='dispatching',updated_at=?
       WHERE id=? AND (status IN ('queued','failed') OR (status='dispatching' AND updated_at<?))`,
      now(),
      run.id,
      new Date(Date.now() - DISPATCH_STALE_MS).toISOString(),
    );

    return claimed.changes > 0;
  };

  const dispatch = async (run: RunRow, previous: PrReviewRunStatus) => {
    const output = {
      title: "Queued",
      summary: "Whiteboard is preparing a review of this commit.",
    };

    // A retried run reopens the check its failure completed.
    if (previous === "failed" && run.check_run_id)
      await checks.update({
        repo: run.repo,
        checkRunId: run.check_run_id,
        status: "in_progress",
        output,
      });
    else await ensureCheck(run, output);

    // The webhook's base is the base branch's tip; the review is of what
    // the PR changed since it forked.
    const baseSha = await input.mergeBase({
      repo: run.repo,
      baseSha: run.base_sha,
      headSha: run.head_sha,
    });

    const job = await jobs.submit(
      {
        repo: `${webUrl}/${run.repo}`,
        baseSha,
        headSha: run.head_sha,
        pullRequest: {
          url: `${webUrl}/${run.repo}/pull/${run.pr_number}`,
          number: run.pr_number,
          installationId: Number(run.installation_id),
        },
      },
      `github-app:${run.installation_id}`,
    );

    await setRun(run.id, {
      status: "preparing",
      base_sha: baseSha,
      job_id: job.id,
      error: null,
    });

    // The delivery is answered first; the job runs behind it and anything
    // it leaves unfinished is picked up by the next reconcile.
    void jobs
      .run(job.id)
      .then(() => reconcile())
      .catch((cause: unknown) =>
        log(`pr review job ${job.id} did not finish: ${String(cause)}`),
      );
  };

  const reconcileOnce = async () => {
    const pending = await meta.all<RunRow>(
      "SELECT * FROM pr_review_runs WHERE status='preparing' AND job_id IS NOT NULL",
    );

    for (const run of pending) {
      const job = await jobs.get(run.job_id!);

      if (!job || (job.status !== "succeeded" && job.status !== "failed"))
        continue;

      // The run leaves `preparing` only once GitHub has the final check, so
      // a rejected update is retried by the next reconcile, not lost.
      try {
        if (job.status === "succeeded") {
          const reviewUrl = job.reviewId
            ? `${publicUrl}/r/${encodeURIComponent(job.reviewId)}`
            : null;

          if (run.check_run_id)
            await checks.update({
              repo: run.repo,
              checkRunId: run.check_run_id,
              conclusion: "neutral",
              output: {
                title: "Review ready",
                summary:
                  "A Whiteboard review was prepared for this commit. An AI-authored summary is not generated yet.",
              },
              ...(reviewUrl && { detailsUrl: reviewUrl }),
            });

          await setRun(
            run.id,
            {
              status: "prepared",
              review_id: job.reviewId ?? null,
              review_url: reviewUrl,
            },
            "preparing",
          );
        } else {
          if (run.check_run_id)
            await checks.update({
              repo: run.repo,
              checkRunId: run.check_run_id,
              conclusion: "failure",
              output: {
                title: "Review could not be prepared",
                summary:
                  "Whiteboard could not prepare a review of this commit. Redeliver the webhook or push a new commit to try again.",
              },
            });

          await setRun(
            run.id,
            { status: "failed", error: job.error ?? "Preparation failed." },
            "preparing",
          );
        }
      } catch (cause) {
        log(`pr review ${run.id} check update failed: ${String(cause)}`);
      }
    }
  };

  // One pass at a time in this process, so a pass triggered while another
  // is mid-update finds the run already finished instead of repeating it.
  let reconciling: Promise<void> = Promise.resolve();

  const reconcile = () => {
    reconciling = reconciling.then(reconcileOnce, reconcileOnce);

    return reconciling;
  };

  const handleWebhook = async (request: Request): Promise<Response> => {
    const body = await readBody(request);

    if (!body) return reply(413, { error: "Payload too large." });

    if (
      !signatureMatches(
        config.webhookSecret,
        body,
        request.headers.get("x-hub-signature-256"),
      )
    )
      return reply(401, { error: "Invalid signature." });

    const deliveryId = request.headers.get("x-github-delivery");

    if (!deliveryId) return reply(400, { error: "Missing delivery id." });

    const event = request.headers.get("x-github-event");

    if (event === "ping") return reply(200, { ignored: "ping" });

    // Redeliveries reuse the delivery id, so it cannot be what makes a
    // delivery a no-op: a redelivered failure must be able to retry. The
    // table is the operator's trail of what each delivery did.
    const record = (outcome: string) =>
      meta
        .run(
          `INSERT INTO github_deliveries(delivery_id,outcome,received_at) VALUES(?,?,?)
           ON CONFLICT(delivery_id) DO UPDATE SET outcome=excluded.outcome,received_at=excluded.received_at`,
          deliveryId,
          outcome,
          now(),
        )
        .catch(() => {});

    const ignore = async (reason: string) => {
      await record(`ignored: ${reason}`);

      return reply(200, { ignored: reason });
    };

    if (event !== "pull_request") return ignore("unsupported event");

    let payload: z.infer<typeof payloadSchema>;

    try {
      payload = payloadSchema.parse(JSON.parse(body.toString("utf8")));
    } catch {
      return reply(400, { error: "Malformed payload." });
    }

    if (!ACTIONS.has(payload.action)) return ignore("unsupported action");

    const repo = payload.repository.full_name.toLowerCase();
    const pr = payload.pull_request;

    if (!config.repos.includes(repo)) return ignore("repository not enabled");

    const installation = payload.installation?.id;

    if (
      !installation ||
      (input.installationId && String(installation) !== input.installationId)
    )
      return ignore("installation not allowed");

    if (pr.draft && !config.drafts) return ignore("draft pull request");

    if (!SHA.test(pr.head.sha) || !SHA.test(pr.base.sha))
      return reply(400, { error: "Malformed payload." });

    try {
      const runKey = createHash("sha256")
        .update(`${installation}|${repo}|${payload.number}|${pr.head.sha}`)
        .digest("hex");

      const fork = pr.head.repo?.full_name.toLowerCase() !== repo;

      const run = await meta.transaction(async () => {
        await meta.run(
          `INSERT INTO pr_review_runs(id,run_key,installation_id,repo,pr_number,base_sha,head_sha,status,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_key) DO NOTHING`,
          randomUUID(),
          runKey,
          String(installation),
          repo,
          payload.number,
          pr.base.sha,
          pr.head.sha,
          fork ? "unsupported" : "queued",
          now(),
          now(),
        );

        await meta.run(
          "UPDATE pr_review_runs SET superseded=1,updated_at=? WHERE installation_id=? AND repo=? AND pr_number=? AND run_key<>? AND superseded=0",
          now(),
          String(installation),
          repo,
          payload.number,
          runKey,
        );

        return (await meta.get<RunRow>(
          "SELECT * FROM pr_review_runs WHERE run_key=?",
          runKey,
        ))!;
      });

      if (run.status === "unsupported") {
        if (!run.check_run_id) {
          const checkRunId = await ensureCheck(run, {
            title: "Not supported",
            summary: "Whiteboard does not review pull requests from forks yet.",
          });

          await checks.update({
            repo: run.repo,
            checkRunId,
            conclusion: "neutral",
            output: {
              title: "Fork pull requests are not supported",
              summary:
                "Whiteboard reviews only pull requests whose branch lives in the base repository.",
            },
          });
        }

        await record("unsupported: fork");

        return reply(200, { runId: run.id, unsupported: "fork" });
      }

      const previous = run.status;

      if (!(await claim(run))) {
        await record("duplicate");
        void reconcile().catch(() => {});

        return reply(200, { runId: run.id, duplicate: true });
      }

      try {
        await dispatch((await getRun(run.id))!, previous);
      } catch (cause) {
        // Hand the run back so the redelivery that retries can claim it.
        await setRun(run.id, { status: previous }).catch(() => {});
        throw cause;
      }

      await record("queued");

      return reply(202, { runId: run.id });
    } catch (cause) {
      await record("error");
      log(`pr review delivery ${deliveryId} failed: ${String(cause)}`);

      return reply(500, { error: "Could not queue the review." });
    }
  };

  return { handleWebhook, reconcile };
}
