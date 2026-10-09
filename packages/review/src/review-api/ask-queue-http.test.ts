import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createReviewApi } from "./http.js";
import { ReviewStore } from "./store.js";

let dir: string;

let store: ReviewStore;

afterEach(async () => {
  await store?.close();

  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("hosted ask queue routes", () => {
  it("lets a board enqueue and poll while a connector claims and completes", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ask-queue-http-"));
    store = await ReviewStore.open(path.join(dir, "review.db"), {
      validatePins: async () => {},
      validateSource: async () => {},
      validateResource: async () => {},
    });

    const created = await store.execute({
      operation: {
        type: "create",
        title: "Example",
        target: {
          kind: "commits",
          repositoryId: "repo",
          base: "base",
          head: "head",
        },
      },
    });

    const api = createReviewApi(store);

    const queued = await api.request("/asks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reviewId: created.reviewId,
        prompt: "Draw the login flow",
      }),
    });

    expect(queued.status).toBe(202);
    const { askId } = (await queued.json()) as { askId: string };

    const pending = await api.request("/asks/pending");
    expect(await pending.json()).toMatchObject({
      asks: [{ id: askId, status: "pending" }],
    });

    const claim = await api.request(`/asks/${askId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "connector" }),
    });

    expect(claim.status).toBe(200);

    const duplicate = await api.request(`/asks/${askId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "other" }),
    });

    expect(duplicate.status).toBe(409);

    const completed = await api.request(`/asks/${askId}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "connector", resultRefs: ["block-1"] }),
    });

    expect(completed.status).toBe(200);
    expect(await (await api.request(`/asks/${askId}`)).json()).toMatchObject({
      ask: { status: "done", resultRefs: ["block-1"] },
    });
  });
});
