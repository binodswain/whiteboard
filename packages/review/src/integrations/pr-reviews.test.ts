import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { normalizeGitHubRemote } from "@dev.fast/review-share-protocol";
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

const FORK_POINT = "d".repeat(40);

const dirs: string[] = [];

afterEach(async () =>
  Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  ),
);

type Overrides = { fail?: boolean; mergeBaseFails?: boolean };

async function harness(overrides: Overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "whiteboard-pr-reviews-"));
  dirs.push(dir);

  const meta = await createMetadataStore({
    kind: "sqlite",
    dir: path.join(dir, "review.db"),
  });

  const prepared: PrepareReviewInput[] = [];

  const state = {
    fail: overrides.fail ?? false,
    mergeBaseFails: overrides.mergeBaseFails ?? false,
    updateFails: 0,
    createFails: 0,
  };

  const jobs = createQueueJobRunner(
    meta,
    async (input) => {
      prepared.push(input);

      if (state.fail) throw new Error("secret-token leaked in git stderr");

      return {
        reviewId: `review-${input.headSha.slice(0, 7)}`,
        // What a bind-address discovery URL carrying a token looks like.
        url: `http://127.0.0.1:7421/r/review-${input.headSha.slice(0, 7)}#token=secret`,
      };
    },
    { maxAttempts: 1 },
  );

  const created: {
    id: string;
    headSha: string;
    conclusion?: string;
    text: string;
  }[] = [];

  const updates: {
    checkRunId: string;
    conclusion?: string;
    status?: string;
    detailsUrl?: string;
    text: string;
  }[] = [];

  const checks: CheckRunsClient = {
    async create({ headSha, conclusion, output }) {
      if (state.createFails > 0) {
        state.createFails--;

        throw new Error("GitHub is unavailable");
      }

      const id = `check-${created.length + 1}`;

      created.push({
        id,
        headSha,
        conclusion,
        text: `${output.title} ${output.summary}`,
      });

      return id;
    },
    async update({ checkRunId, conclusion, status, detailsUrl, output }) {
      if (state.updateFails > 0) {
        state.updateFails--;

        throw new Error("GitHub is unavailable");
      }

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
    config: {
      webhookSecret: SECRET,
      repos: ["octo/repo"],
      drafts: false,
      publicUrl: "https://whiteboard.test",
    },
    mergeBase: async () => {
      if (state.mergeBaseFails) throw new Error("GitHub is unavailable");

      return FORK_POINT;
    },
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
  const settle = async (attempts = 50) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
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

    expect(h.created).toMatchObject([{ id: "check-1", headSha: HEAD_A }]);
    expect(h.prepared).toEqual([
      {
        repo: "https://github.com/octo/repo",
        baseSha: FORK_POINT,
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
    // The checkout source only accepts what it can normalize.
    expect(normalizeGitHubRemote(h.prepared[0]!.repo)).toBeTruthy();
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

  it("says fork PRs are unsupported with one completed check, never reviewing them", async () => {
    const h = await harness();

    const response = await h.prReviews.handleWebhook(
      delivery({ forkOf: "stranger/repo" }),
    );

    expect(await response.json()).toMatchObject({ unsupported: "fork" });
    expect(h.prepared).toEqual([]);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ conclusion: "neutral" });
    expect(h.created[0]!.text).toMatch(/fork/i);
    expect((await h.runs())[0]).toMatchObject({ status: "unsupported" });

    await h.prReviews.handleWebhook(delivery({ forkOf: "stranger/repo" }));
    expect(h.created).toHaveLength(1);
    await h.close();
  });

  it("makes one fork check when deliveries race, and finishes it after a GitHub error", async () => {
    const h = await harness();
    h.state.createFails = 1;

    const failed = await h.prReviews.handleWebhook(
      delivery({ id: "a", forkOf: "stranger/repo" }),
    );

    expect(failed.status).toBe(500);

    await Promise.all([
      h.prReviews.handleWebhook(delivery({ id: "a", forkOf: "stranger/repo" })),
      h.prReviews.handleWebhook(delivery({ id: "b", forkOf: "stranger/repo" })),
      h.prReviews.handleWebhook(delivery({ id: "c", forkOf: "stranger/repo" })),
    ]);

    expect(h.created).toHaveLength(1);
    expect((await h.runs())[0]).toMatchObject({ status: "unsupported" });
    await h.close();
  });

  it("resumes a run abandoned before it was dispatched", async () => {
    const h = await harness({ mergeBaseFails: true });

    expect((await h.prReviews.handleWebhook(delivery())).status).toBe(500);
    expect(h.prepared).toEqual([]);

    // GitHub does not redeliver; a worker pass has to pick the run up.
    h.state.mergeBaseFails = false;
    await h.prReviews.reconcile();
    expect(h.prepared).toEqual([]);

    await h.meta.run(
      "UPDATE pr_review_runs SET updated_at='2000-01-01T00:00:00.000Z'",
    );
    await h.settle();

    expect(h.prepared).toHaveLength(1);
    expect(h.created).toHaveLength(1);
    expect((await h.runs())[0]).toMatchObject({ status: "prepared" });
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

  it("links the check at the public origin, never the discovery address or a token", async () => {
    const h = await harness();
    await h.prReviews.handleWebhook(delivery());
    await h.settle();

    const detailsUrl = h.updates[0]!.detailsUrl!;

    expect(detailsUrl).toBe("https://whiteboard.test/r/review-aaaaaaa");
    expect(detailsUrl).not.toMatch(/token|127\.0\.0\.1/);
    await h.close();
  });

  it("keeps a run open until GitHub accepts its final check update", async () => {
    const h = await harness();
    h.state.updateFails = 1;
    await h.prReviews.handleWebhook(delivery());
    await h.settle(50);

    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({
      checkRunId: "check-1",
      detailsUrl: "https://whiteboard.test/r/review-aaaaaaa",
    });
    expect((await h.runs())[0]).toMatchObject({ status: "prepared" });
    await h.close();
  });

  it("creates one check and one job when deliveries for a head race", async () => {
    const h = await harness();

    const responses = await Promise.all([
      h.prReviews.handleWebhook(delivery({ id: "one" })),
      h.prReviews.handleWebhook(delivery({ id: "two" })),
      h.prReviews.handleWebhook(delivery({ id: "three" })),
    ]);

    await h.settle();

    expect(
      responses.filter((response) => response.status === 202),
    ).toHaveLength(1);
    expect(h.created).toHaveLength(1);
    expect(h.prepared).toHaveLength(1);
    await h.close();
  });

  it("stops reading an unsigned body at the limit even without a Content-Length", async () => {
    const h = await harness();
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
      },
    });

    const response = await h.prReviews.handleWebhook(
      new Request("http://whiteboard.invalid/integrations/github/webhook", {
        method: "POST",
        headers: { "x-github-event": "pull_request" },
        body,
        duplex: "half",
      } as RequestInit),
    );

    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(20);
    await h.close();
  });

  it("answers 500 when the merge base cannot be resolved, and a redelivery finishes the run", async () => {
    const h = await harness({ mergeBaseFails: true });
    const failed = await h.prReviews.handleWebhook(delivery({ id: "x" }));

    expect(failed.status).toBe(500);
    expect(h.prepared).toEqual([]);

    h.state.mergeBaseFails = false;
    const retried = await h.prReviews.handleWebhook(delivery({ id: "x" }));
    await h.settle();

    expect(retried.status).toBe(202);
    expect(await h.runs()).toHaveLength(1);
    expect(h.created).toHaveLength(1);
    expect(h.prepared).toHaveLength(1);
    await h.close();
  });
});
