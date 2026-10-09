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

  it("claims a queued job once across runners and records readable failures", async () => {
    const store = await database();
    let runs = 0;
    const prepare = async () => {
      runs++;
      throw new Error("checkout failed");
    };
    const a = createQueueJobRunner(store, prepare);
    const b = createQueueJobRunner(store, prepare);
    const job = await a.submit(input);
    expect(await Promise.all([a.runNext(), b.runNext()])).toEqual([
      true,
      false,
    ]);
    expect(runs).toBe(1);
    expect(await a.get(job.id)).toMatchObject({
      status: "pending",
      attempts: 1,
      error: "checkout failed",
    });
    await store.close();
  });

  it("reclaims an expired lease and marks attempts exhausted", async () => {
    const store = await database();
    const job = await createQueueJobRunner(
      store,
      async () => ({ reviewId: "never" }),
      { leaseMs: 1, maxAttempts: 1 },
    ).submit(input);
    await store.run(
      "UPDATE jobs_jobs SET status='running',attempts=1,lease_until=? WHERE id=?",
      Date.now() - 1,
      job.id,
    );
    expect(
      await createQueueJobRunner(store, async () => ({ reviewId: "never" }), {
        maxAttempts: 1,
      }).runNext(),
    ).toBe(false);
    expect(
      await createQueueJobRunner(store, async () => ({
        reviewId: "never",
      })).get(job.id),
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining("lease expired"),
    });
    await store.close();
  });
});
