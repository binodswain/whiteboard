import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMetadataStore } from "@review/review-api/storage/metadata-store.js";
import { afterEach, describe, expect, it } from "vitest";

import { createInlineJobRunner, createQueueJobRunner } from "./job-runner.js";

const dirs: string[] = [];

async function database() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "whiteboard-jobs-"));
  dirs.push(dir);

  return createMetadataStore({
    kind: "sqlite",
    dir: path.join(dir, "review.db"),
  });
}

afterEach(async () =>
  Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  ),
);

const input = { repo: "owner/repo", baseSha: "base", headSha: "head" };

describe("review jobs", () => {
  it("runs inline and reuses the same job for identical inputs", async () => {
    const store = await database();
    let runs = 0;

    const runner = createInlineJobRunner(store, async () => ({
      reviewId: `review-${++runs}`,
    }));

    const first = await runner.submit(input);
    const second = await runner.submit(input);
    expect(first.status).toBe("succeeded");
    expect(second.id).toBe(first.id);
    expect(second.reviewId).toBe(first.reviewId);
    expect(runs).toBe(1);
    await store.close();
  });

  it("waits with bounded polling when another runner holds this inline job", async () => {
    const store = await database();
    let started!: () => void;
    let finish!: (value: { reviewId: string }) => void;

    const startedWork = new Promise<void>((resolve) => {
      started = resolve;
    });

    const prepare = async () => {
      started();

      return new Promise<{ reviewId: string }>((resolve) => {
        finish = resolve;
      });
    };

    const queue = createQueueJobRunner(store, prepare);
    const job = await queue.submit(input);
    const queuedWork = queue.run(job.id);
    await startedWork;

    const inline = createInlineJobRunner(store, prepare, { waitMs: 90 });
    const startedAt = Date.now();
    const inlineResult = await inline.submit(input);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(70);
    expect(inlineResult).toMatchObject({ id: job.id, status: "running" });

    finish({ reviewId: "finished-by-queue" });
    await queuedWork;
    expect(await inline.get(job.id)).toMatchObject({
      status: "succeeded",
      reviewId: "finished-by-queue",
    });
    await store.close();
  });

  it("claims a queued job once across runners", async () => {
    const store = await database();
    let runs = 0;
    const prepare = async () => ({ reviewId: `review-${++runs}` });
    const a = createQueueJobRunner(store, prepare);
    const b = createQueueJobRunner(store, prepare);
    const job = await a.submit(input);
    expect(await Promise.all([a.runNext(), b.runNext()])).toEqual([
      true,
      false,
    ]);
    expect(runs).toBe(1);
    expect(await a.get(job.id)).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
    await store.close();
  });

  it("stores the submitter and supplies it to the queued worker", async () => {
    const store = await database();
    let context: { jobId: string; submitterId?: string } | undefined;

    const runner = createQueueJobRunner(store, async (_input, jobContext) => {
      context = jobContext;

      return { reviewId: "review-for-submitter" };
    });

    const job = await runner.submit(input, "proxy:smoke-user");

    expect(job.submitterId).toBe("proxy:smoke-user");
    await runner.run(job.id);
    expect(context).toEqual({ jobId: job.id, submitterId: "proxy:smoke-user" });
    await store.close();
  });

  it("reclaims an expired lease and retries the job", async () => {
    const store = await database();

    const job = await createQueueJobRunner(
      store,
      async () => ({ reviewId: "never" }),
      { leaseMs: 1, maxAttempts: 3 },
    ).submit(input);

    await store.run(
      "UPDATE jobs_jobs SET status='running',attempts=1,lease_until=? WHERE id=?",
      Date.now() - 1,
      job.id,
    );
    expect(
      await createQueueJobRunner(store, async () => ({ reviewId: "retried" }), {
        maxAttempts: 3,
      }).runNext(),
    ).toBe(true);
    expect(
      await createQueueJobRunner(store, async () => ({
        reviewId: "unused",
      })).get(job.id),
    ).toMatchObject({ status: "succeeded", attempts: 2, reviewId: "retried" });
    await store.close();
  });

  it("records a readable terminal failure", async () => {
    const store = await database();

    const runner = createQueueJobRunner(
      store,
      async () => {
        throw new Error("checkout failed");
      },
      { maxAttempts: 1 },
    );

    const job = await runner.submit(input);
    expect(await runner.runNext()).toBe(true);
    expect(await runner.get(job.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "checkout failed",
    });
    await store.close();
  });

  it("resets a failed idempotent job so it can be retried", async () => {
    const store = await database();
    let attempts = 0;

    const runner = createQueueJobRunner(
      store,
      async () => {
        if (++attempts === 1) throw new Error("first attempt failed");

        return { reviewId: "review-after-retry" };
      },
      { maxAttempts: 1 },
    );

    const original = await runner.submit(input);
    expect(await runner.runNext()).toBe(true);
    expect(await runner.get(original.id)).toMatchObject({
      status: "failed",
      attempts: 1,
    });

    const retry = await runner.submit(input);
    expect(retry).toMatchObject({
      id: original.id,
      status: "pending",
      attempts: 0,
    });
    expect(retry.error).toBeUndefined();
    expect(await runner.runNext()).toBe(true);
    expect(await runner.get(original.id)).toMatchObject({
      status: "succeeded",
      attempts: 1,
      reviewId: "review-after-retry",
    });
    await store.close();
  });
});
