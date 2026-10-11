import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type PrepareReviewInput,
  createQueueJobRunner,
} from "@review/jobs/job-runner.js";
import { createMetadataStore } from "@review/review-api/storage/metadata-store.js";
import { afterEach, describe, expect, it } from "vitest";

import type { CheckRunsClient } from "./github-checks.js";
import { createPrReviews } from "./pr-reviews.js";

const SECRET = "webhook-secret";

const BASE = "b".repeat(40);

const HEAD_A = "a".repeat(40);

const HEAD_B = "c".repeat(40);

const dirs: string[] = [];

afterEach(async () =>
  Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  ),
);

type Overrides = { fail?: boolean };

async function harness(overrides: Overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "whiteboard-pr-reviews-"));
  dirs.push(dir);

  const meta = await createMetadataStore({
    kind: "sqlite",
    dir: path.join(dir, "review.db"),
  });

  const prepared: PrepareReviewInput[] = [];
  const state = { fail: overrides.fail ?? false };

  const jobs = createQueueJobRunner(
    meta,
    async (input) => {
      prepared.push(input);

      if (state.fail) throw new Error("secret-token leaked in git stderr");

      return {
        reviewId: `review-${input.headSha.slice(0, 7)}`,
        url: `https://whiteboard.test/r/review-${input.headSha.slice(0, 7)}`,
      };
    },
    { maxAttempts: 1 },
  );

  const created: { id: string; headSha: string }[] = [];

  const updates: {
    checkRunId: string;
    conclusion?: string;
    status?: string;
    detailsUrl?: string;
    text: string;
  }[] = [];

  const checks: CheckRunsClient = {
    async create({ headSha }) {
      const id = `check-${created.length + 1}`;
      created.push({ id, headSha });

      return id;
    },
    async update({ checkRunId, conclusion, status, detailsUrl, output }) {
      updates.push({
        checkRunId,
        conclusion,
        status,
        detailsUrl,
        text: `${output.title} ${output.summary}`,
      });
    },
  };

  const prReviews = createPrReviews({
    config: { webhookSecret: SECRET, repos: ["octo/repo"], drafts: false },
    installationId: "99",
    webUrl: "https://github.com",
    meta,
    jobs,
    checks,
  });

  const runs = () =>
    meta.all<{ head_sha: string; status: string; superseded: number }>(
      "SELECT * FROM pr_review_runs ORDER BY created_at, head_sha",
    );

  /** Waits for the background job the delivery started. */
  const settle = async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      await prReviews.reconcile();

      if (
        (await runs()).every(
          (run) => !["queued", "preparing"].includes(run.status),
        )
      )
        return;

      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  return {
    meta,
    prReviews,
    prepared,
    created,
    updates,
    runs,
    settle,
    state,
    close: () => meta.close(),
  };
}

function delivery(
  options: {
    id?: string;
    event?: string;
    action?: string;
    head?: string;
    draft?: boolean;
    repo?: string;
    installation?: number;
    forkOf?: string;
    secret?: string;
  } = {},
) {
  const repo = options.repo ?? "octo/Repo";

  const body = JSON.stringify({
    action: options.action ?? "opened",
    number: 7,
    installation: { id: options.installation ?? 99 },
    repository: { full_name: repo },
    pull_request: {
      draft: options.draft ?? false,
      base: { sha: BASE },
      head: {
        sha: options.head ?? HEAD_A,
        repo: { full_name: options.forkOf ?? repo },
      },
    },
  });

  const signature = createHmac("sha256", options.secret ?? SECRET)
    .update(body)
    .digest("hex");

  return new Request("http://whiteboard.invalid/integrations/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": options.event ?? "pull_request",
      "x-github-delivery": options.id ?? crypto.randomUUID(),
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
  });
}

describe("PR review webhook", () => {
  it("rejects a bad signature without queuing anything", async () => {
    const h = await harness();

    const response = await h.prReviews.handleWebhook(
      delivery({ secret: "wrong" }),
    );

    expect(response.status).toBe(401);
    expect(await h.runs()).toEqual([]);
    expect(h.created).toEqual([]);
    expect(await h.meta.all("SELECT * FROM jobs_jobs")).toEqual([]);
    await h.close();
  });

  it("turns an opened PR into one review job and one check for its head", async () => {
    const h = await harness();

    const response = await h.prReviews.handleWebhook(delivery());

    expect(response.status).toBe(202);
    await h.settle();

    expect(h.created).toEqual([{ id: "check-1", headSha: HEAD_A }]);
    expect(h.prepared).toEqual([
      {
        repo: "octo/repo",
        baseSha: BASE,
        headSha: HEAD_A,
        pullRequest: {
          url: "https://github.com/octo/repo/pull/7",
          number: 7,
          installationId: 99,
        },
      },
    ]);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({
      checkRunId: "check-1",
      detailsUrl: "https://whiteboard.test/r/review-aaaaaaa",
    });
    expect((await h.runs())[0]).toMatchObject({ status: "prepared" });
    await h.close();
  });

  it("does nothing more for a redelivery or a repeat event for the same head", async () => {
    const h = await harness();
    await h.prReviews.handleWebhook(delivery({ id: "same" }));
    await h.settle();

    const again = await h.prReviews.handleWebhook(delivery({ id: "same" }));

    const reopened = await h.prReviews.handleWebhook(
      delivery({ action: "reopened" }),
    );

    expect(again.status).toBe(200);
    expect(reopened.status).toBe(200);
    expect(await h.runs()).toHaveLength(1);
    expect(h.created).toHaveLength(1);
    expect(h.prepared).toHaveLength(1);
    await h.close();
  });

  it("keeps a late result for an old head off the newest head's check", async () => {
    const h = await harness();
    await h.prReviews.handleWebhook(delivery({ head: HEAD_A }));
    await h.settle();

    await h.prReviews.handleWebhook(
      delivery({ action: "synchronize", head: HEAD_B }),
    );
    await h.settle();

    const runs = await h.runs();

    expect(runs.map((run) => [run.head_sha, run.superseded])).toEqual([
      [HEAD_A, 1],
      [HEAD_B, 0],
    ]);
    expect(h.created.map((check) => check.headSha)).toEqual([HEAD_A, HEAD_B]);
    expect(
      h.updates.map((update) => [update.checkRunId, update.detailsUrl]),
    ).toEqual([
      ["check-1", "https://whiteboard.test/r/review-aaaaaaa"],
      ["check-2", "https://whiteboard.test/r/review-ccccccc"],
    ]);
    await h.close();
  });

  it("ignores drafts, other repositories, other installations and other actions", async () => {
    const h = await harness();

    for (const options of [
      { draft: true },
      { repo: "octo/other" },
      { installation: 1 },
      { action: "closed" },
      { event: "issues" },
    ]) {
      const response = await h.prReviews.handleWebhook(delivery(options));
      expect(response.status).toBe(200);
      expect(await response.json()).toHaveProperty("ignored");
    }

    expect(await h.runs()).toEqual([]);
    expect(h.created).toEqual([]);
    await h.close();
  });

  it("says fork PRs are unsupported instead of reviewing them", async () => {
    const h = await harness();

    const response = await h.prReviews.handleWebhook(
      delivery({ forkOf: "stranger/repo" }),
    );

    expect(await response.json()).toMatchObject({ unsupported: "fork" });
    expect(h.prepared).toEqual([]);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({ conclusion: "neutral" });
    expect(h.updates[0]!.text).toMatch(/fork/i);

    await h.prReviews.handleWebhook(delivery({ forkOf: "stranger/repo" }));
    expect(h.created).toHaveLength(1);
    await h.close();
  });

  it("fails the check without leaking the error, and a redelivery retries", async () => {
    const h = await harness({ fail: true });
    await h.prReviews.handleWebhook(delivery({ id: "first" }));
    await h.settle();

    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({ conclusion: "failure" });
    expect(h.updates[0]!.text).not.toContain("secret-token");
    expect(h.updates[0]!.detailsUrl).toBeUndefined();
    expect((await h.runs())[0]).toMatchObject({ status: "failed" });

    h.state.fail = false;
    await h.prReviews.handleWebhook(delivery({ id: "first" }));
    await h.settle();

    expect(await h.runs()).toHaveLength(1);
    expect(h.created).toHaveLength(1);
    expect(h.updates.at(-1)).toMatchObject({
      checkRunId: "check-1",
      detailsUrl: "https://whiteboard.test/r/review-aaaaaaa",
    });
    expect((await h.runs())[0]).toMatchObject({ status: "prepared" });
    await h.close();
  });
});
