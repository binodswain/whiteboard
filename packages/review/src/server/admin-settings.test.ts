import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AuthPrincipal } from "@review/auth/index.js";
import { createReviewApi } from "@review/review-api/http.js";
import { ReviewStore } from "@review/review-api/store.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  type AdminSettingsPatch,
  adminSettingsRoutes,
  createAdminSettings,
  isAdmin,
} from "./admin-settings.js";

const SECRET = "s".repeat(40);

let dir: string | undefined;

let store: ReviewStore | undefined;

afterEach(async () => {
  await store?.close();

  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function open() {
  dir = mkdtempSync(path.join(tmpdir(), "admin-settings-"));
  store = await ReviewStore.open(path.join(dir, "review.db"), {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });

  const settings = createAdminSettings({
    meta: store.metadataStore(),
    secret: SECRET,
    defaults: { repos: ["acme/env"], drafts: false, authoring: false },
  });

  return { store, settings };
}

const ada: AuthPrincipal = { id: "gh:1", login: "Ada", via: "github" };

const bob: AuthPrincipal = { id: "gh:2", login: "bob", via: "github" };

/** Who each request is, by its `x-user` header. */
const authenticate = async (request: Request) =>
  ({ ada, bob, runner: { ...ada, via: "api-token" as const } })[
    request.headers.get("x-user") ?? ""
  ] ?? null;

describe("admin settings", () => {
  it("keep the reviewer key sealed and out of what the page sees", async () => {
    const { store, settings } = await open();

    expect((await settings.view()).prReviews.repos).toEqual(["acme/env"]);
    expect(await settings.reviewerAgent()).toBeUndefined();

    const view = await settings.update(
      {
        prReviews: { repos: ["Acme/Web", "acme/web"], authoring: true },
        reviewer: { provider: "openrouter", model: "m-1", apiKey: "sk-123" },
      },
      "ada",
    );

    expect(view).toMatchObject({
      prReviews: { repos: ["acme/web"], drafts: false, authoring: true },
      reviewer: { provider: "openrouter", model: "m-1", apiKeySet: true },
      updatedBy: "ada",
    });
    expect(JSON.stringify(view)).not.toContain("sk-123");

    const row = await store
      .metadataStore()
      .get<{ value: string }>("SELECT value FROM admin_settings");

    expect(row?.value).not.toContain("sk-123");
    expect(await settings.reviewerAgent()).toEqual({
      provider: "openrouter",
      model: "m-1",
      env: { OPENROUTER_API_KEY: "sk-123" },
    });

    // Leaving the key out keeps it; null clears it.
    await settings.update({ reviewer: { model: null } }, "ada");
    expect((await settings.reviewerAgent())?.env).toEqual({
      OPENROUTER_API_KEY: "sk-123",
    });

    await settings.update({ reviewer: { apiKey: null } }, "ada");
    expect(await settings.reviewerAgent()).toBeUndefined();
  });

  it("let only signed-in admins read and change them", async () => {
    const { settings } = await open();

    const routes = adminSettingsRoutes({
      auth: { authenticate },
      admins: ["ada"],
      settings,
    });

    const call = (user: string, method = "GET", body?: AdminSettingsPatch) =>
      routes.request("http://localhost/settings", {
        method,
        headers: { "x-user": user, "content-type": "application/json" },
        body: body && JSON.stringify(body),
      });

    expect((await call("bob")).status).toBe(403);
    expect((await call("runner")).status).toBe(403);
    expect((await call("ada")).status).toBe(200);
    expect(
      (
        await call("ada", "PUT", {
          // @ts-expect-error: the server must refuse an unknown provider.
          reviewer: { provider: "nope" },
        })
      ).status,
    ).toBe(400);

    const saved = await call("ada", "PUT", { prReviews: { drafts: true } });

    expect(await saved.json()).toMatchObject({
      prReviews: { drafts: true },
      updatedBy: "Ada",
    });
  });

  it("give pull request asks, and the reviewer key, only to admins", async () => {
    const { store, settings } = await open();

    await settings.update(
      { reviewer: { provider: "anthropic", apiKey: "sk-9" } },
      "ada",
    );

    const api = createReviewApi(
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        authenticate,
        canReadRepo: async () => true,
        canRunPrReviews: (principal) =>
          isAdmin(principal, ["ada"], { tokens: true }),
        reviewerAgent: () => settings.reviewerAgent(),
      },
    );

    // No stored review, so only the ask gate decides.
    const reviewId = "pr-review";

    const askId = await store.askQueue.create({
      reviewId,
      kind: "pr-review",
      prompt: "Summarize",
      createdBy: "github-app:1",
    });

    const call = (user: string, route: string, body?: { runnerId: string }) =>
      api.request(`http://localhost${route}`, {
        method: body ? "POST" : "GET",
        headers: { "x-user": user, "content-type": "application/json" },
        body: body && JSON.stringify(body),
      });

    expect(await (await call("bob", "/asks/pending")).json()).toEqual({
      asks: [],
    });
    expect(
      (await call("bob", `/asks/${askId}/claim`, { runnerId: "r" })).status,
    ).toBe(403);

    const claimed = await call("runner", `/asks/${askId}/claim`, {
      runnerId: "r",
    });

    expect(await claimed.json()).toMatchObject({
      agent: { provider: "anthropic", env: { ANTHROPIC_API_KEY: "sk-9" } },
    });
  });
});
