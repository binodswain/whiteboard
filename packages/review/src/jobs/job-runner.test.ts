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
});
