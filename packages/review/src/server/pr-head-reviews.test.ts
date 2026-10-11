import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { openLocalReviewStore } from "@review/review-api/local-data.js";
import { reviewIdForPullRequestHead } from "@review/review-api/origin.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { GlobalReviewDesktopVerbRelay } from "./global-verb-relay.js";
import { createWhiteboardCore } from "./review-server-core.js";

const exec = promisify(execFile);

const PR = "https://github.com/octo/repo/pull/7";

let root: string;

const stops: (() => Promise<void>)[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pr-head-reviews-"));
  vi.stubEnv("DEV_REVIEW_HOME", root);
  vi.stubEnv("DEV_FAST_REVIEW_TELEMETRY_DISABLED", "1");
});

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function commit(repository: string, content: string) {
  await writeFile(path.join(repository, "note.txt"), content);
  await exec("git", ["-C", repository, "add", "."]);
  await exec("git", ["-C", repository, "commit", "--quiet", "-m", content]);

  return (
    await exec("git", ["-C", repository, "rev-parse", "HEAD"])
  ).stdout.trim();
}

it("finds the review a PR already has at a head, and none for a head it lacks", async () => {
  const repository = path.join(root, "source-repo");
  await mkdir(repository);
  await exec("git", ["init", "--quiet", repository]);
  await exec("git", [
    "-C",
    repository,
    "config",
    "user.email",
    "t@example.com",
  ]);
  await exec("git", ["-C", repository, "config", "user.name", "Test"]);

  const base = await commit(repository, "base\n");
  const first = await commit(repository, "first\n");
  const second = await commit(repository, "second\n");

  const profile = await openLocalReviewStore(path.join(root, "review.db"));

  const core = createWhiteboardCore({
    profile,
    relay: new GlobalReviewDesktopVerbRelay(),
    token: "test-token-0000000000000000000000000000",
    instanceId: "test-instance",
    scratchpad: () => false,
    status: () => ({}),
    deploymentConfig: {
      mode: "local",
      db: "sqlite",
      blobs: "fs",
      repoSource: "local",
      jobs: "inline",
      auth: "local-token",
    },
  });

  stops.push(async () => {
    await core.close();
    await profile.data.close();
    await profile.store.close();
  });

  const createAt = async (head: string) => {
    const response = await core.api.fetch(
      new Request("http://whiteboard.invalid/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: {
            type: "create",
            title: `octo/repo ${head.slice(0, 7)}`,
            target: { kind: "commits", repositoryPath: repository, base, head },
            pullRequestUrl: PR,
            reuseExisting: false,
            open: false,
          },
        }),
      }),
    );

    expect(response.status).toBe(200);

    return ((await response.json()) as { reviewId: string }).reviewId;
  };

  const reviewOne = await createAt(first);
  const reviewTwo = await createAt(second);
  const meta = profile.store.metadataStore();

  expect(reviewTwo).not.toBe(reviewOne);
  expect(await reviewIdForPullRequestHead(meta, PR, first)).toBe(reviewOne);
  expect(await reviewIdForPullRequestHead(meta, PR.toUpperCase(), second)).toBe(
    reviewTwo,
  );
  expect(await reviewIdForPullRequestHead(meta, PR, base)).toBeUndefined();
  expect(
    await reviewIdForPullRequestHead(
      meta,
      "https://github.com/octo/repo/pull/8",
      first,
    ),
  ).toBeUndefined();
});
