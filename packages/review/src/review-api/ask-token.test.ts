import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadDeploymentConfig,
  publicDeploymentConfig,
} from "@review/server/deployment-config.js";
import { GlobalReviewDesktopVerbRelay } from "@review/server/global-verb-relay.js";
import { createReviewServerApp } from "@review/server/review-server-core.js";
import { afterEach, describe, expect, it } from "vitest";

import { createReviewApi } from "./http.js";
import { ReviewStore } from "./store.js";

const SERVER_TOKEN = `server-${"t".repeat(40)}`;

let dir: string;

let store: ReviewStore;

afterEach(async () => {
  await store?.close();

  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function server() {
  dir = mkdtempSync(path.join(tmpdir(), "ask-token-"));
  store = await ReviewStore.open(path.join(dir, "review.db"), {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });

  const review = async (title: string) =>
    (
      await store.execute({
        operation: {
          type: "create",
          title,
          target: {
            kind: "commits",
            repositoryId: "repo",
            base: "base",
            head: "head",
          },
        },
      })
    ).reviewId;

  const app = createReviewServerApp({
    token: SERVER_TOKEN,
    instanceId: "test-instance",
    serverId: "test-server",
    relay: new GlobalReviewDesktopVerbRelay(),
    deployment: publicDeploymentConfig(loadDeploymentConfig({})),
    askToken: (token) => store.askQueue.authenticateToken(token),
  });

  app.route("/reviews-api", createReviewApi(store));

  const call = (
    token: string,
    route: string,
    init: { method?: string; body?: unknown } = {},
  ) =>
    app.request(`http://localhost/reviews-api${route}`, {
      method: init.method ?? "GET",
      headers: {
        "x-review-token": token,
        ...(init.body !== undefined && { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  return { review, call };
}

describe("per-ask tokens", () => {
  it("author only the claimed ask's review, and only while it is claimed", async () => {
    const { review, call } = await server();
    const own = await review("Own");
    const other = await review("Other");

    const askId = await store.askQueue.create({
      reviewId: own,
      kind: "pr-review",
      prompt: "Summarize",
      createdBy: "github-app:1",
    });

    const claimed = await call(SERVER_TOKEN, `/asks/${askId}/claim`, {
      method: "POST",
      body: { runnerId: "runner" },
    });

    const { token } = (await claimed.json()) as { token: string };

    expect(token).toMatch(/^wba_/);

    expect((await call(token, `/${own}`)).status).toBe(200);
    expect(
      (
        await call(token, `/${own}/comments`, {
          method: "POST",
          body: { body: "## Pull request summary\nLooks fine." },
        })
      ).status,
    ).toBe(201);

    expect((await call(token, `/${other}`)).status).toBe(403);
    expect((await call(token, "")).status).toBe(403);
    expect((await call(token, "/asks/pending")).status).toBe(403);
    expect(
      (
        await call(token, "/commands", {
          method: "POST",
          body: { operation: { type: "delete", reviewId: own } },
        })
      ).status,
    ).toBe(403);

    await call(SERVER_TOKEN, `/asks/${askId}/complete`, {
      method: "POST",
      body: { runnerId: "runner", resultRefs: [] },
    });

    expect((await call(token, `/${own}`)).status).toBe(401);
  });

  it("stop working when the claim's lease runs out", async () => {
    await server();

    const askId = await store.askQueue.create({
      reviewId: "review",
      prompt: "Summarize",
      createdBy: "board",
    });

    const claimed = await store.askQueue.claim(askId, "runner", {
      now: 1000,
      leaseMs: 10,
    });

    expect(
      await store.askQueue.authenticateToken(claimed!.token, 1005),
    ).toEqual({ askId, reviewId: "review" });
    expect(
      await store.askQueue.authenticateToken(claimed!.token, 1011),
    ).toBeUndefined();
  });

  it("let a pull request runner see only pull request asks", async () => {
    const { review, call } = await server();
    const reviewId = await review("Own");

    await store.askQueue.create({
      reviewId,
      prompt: "A person's question",
      createdBy: "board",
    });

    const prAsk = await store.askQueue.create({
      reviewId,
      kind: "pr-review",
      prompt: "Summarize",
      createdBy: "github-app:1",
    });

    const pending = await call(SERVER_TOKEN, "/asks/pending?kind=pr-review");

    expect(await pending.json()).toMatchObject({
      asks: [{ id: prAsk, kind: "pr-review" }],
    });
    expect(
      (
        (await (await call(SERVER_TOKEN, "/asks/pending")).json()) as {
          asks: unknown[];
        }
      ).asks,
    ).toHaveLength(2);
  });
});
