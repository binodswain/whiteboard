/**
 * Behavior tests for the "assign an agent when creating a session" contract:
 *   1. GET /ask/agents – global, not review-scoped.
 *   2. POST /:id/ask  – selection optional; purpose "build" prefixes context.
 *   3. POST /asks     – purpose "build" stores prompt with build preamble.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AskAgentStatus } from "@review/ask/agents.js";
import { buildSessionPrompt } from "@review/ask/build-prompt.js";
import type { AskThread, AskThreadStart } from "@review/ask/thread.js";
import { AskThreads, type AskToolsReach } from "@review/ask/threads.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AskHost } from "./http.js";
import { createReviewApi } from "./http.js";
import type { LocalReviewData } from "./local-data.js";
import { ReviewStore } from "./store.js";

// ---------------------------------------------------------------------------
// Shared stubs
// ---------------------------------------------------------------------------

const pins = {
  repositoryId: "repo",
  base: "base-sha",
  head: "head-sha",
};

/** Stub satisfying only the `agentCheckout` method the ask handler calls. */
const localDataStub: Pick<LocalReviewData, "agentCheckout"> = {
  agentCheckout: async () => ({
    rootPath: "/fake/checkout",
    head: "head-sha",
    live: false,
  }),
};

/**
 * Cast the minimal stub to the full LocalReviewData type the API expects.
 * Only the agentCheckout path is exercised in these tests; all other methods
 * remain on the real class and are never reached.
 */
const localData = localDataStub as LocalReviewData;

/**
 * Build a minimal AskThreads stub.
 *
 * The stub skips the real ACP launcher; `captureStart` lets tests inspect the
 * AskThreadStart (including `context`) that the handler assembled.
 */
function makeThreadsStub(
  captureStart?: (start: AskThreadStart) => void,
): AskThreads {
  // A real AskThreads whose launcher never runs; the request paths here
  // only call open and reach, which are replaced.
  const threads = new AskThreads(() => {
    throw new Error("No agent starts here.");
  });

  return Object.assign(threads, {
    open: (start: AskThreadStart): AskThread => {
      captureStart?.(start);

      // The handler only reads `.id` from the returned thread.
      return { id: start.id ?? "stub-thread-id" } as AskThread;
    },
    reach: async (): Promise<AskToolsReach> => undefined,
  });
}

/** Build an AskHost whose agent list and thread stub are controlled by tests. */
function makeAskHost(
  agents: AskAgentStatus[],
  captureStart?: (start: AskThreadStart) => void,
): AskHost {
  return {
    threads: makeThreadsStub(captureStart),
    agents: async () => agents,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let dir: string;

let store: ReviewStore;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "ask-contract-http-"));
  store = await ReviewStore.open(path.join(dir, "review.db"), {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });
});

afterEach(async () => {
  await store?.close();

  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function createReview(title: string) {
  const result = await store.execute({
    operation: { type: "create", title, target: { kind: "commits", ...pins } },
  });

  return result.reviewId;
}

// ---------------------------------------------------------------------------
// 1. GET /ask/agents — global, not review-scoped
// ---------------------------------------------------------------------------

describe("GET /ask/agents", () => {
  it("returns agents when ask is available", async () => {
    const agentStatus: AskAgentStatus = {
      id: "claude",
      name: "Claude",
      available: true,
      readOnly: false,
      bypass: false,
    };

    const api = createReviewApi(
      store,
      localData,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      makeAskHost([agentStatus]),
    );

    const response = await api.request("/ask/agents");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ agents: [agentStatus] });
  });

  it("returns 404 when no ask host is configured", async () => {
    // createReviewApi without the ask argument → route is never registered.
    const api = createReviewApi(store);

    const response = await api.request("/ask/agents");

    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 2. POST /:id/ask — selection optional; purpose "build" prefixes context
// ---------------------------------------------------------------------------

describe("POST /:id/ask with purpose build", () => {
  it("starts a thread whose context contains the build preamble when no selection is given", async () => {
    const reviewId = await createReview("My Repo");
    let capturedStart: AskThreadStart | undefined;

    const api = createReviewApi(
      store,
      localData,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      makeAskHost([], (s) => {
        capturedStart = s;
      }),
    );

    const response = await api.request(`/${reviewId}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "claude",
        question: { text: "Map the auth flow" },
        purpose: "build",
        // selection intentionally omitted
      }),
    });

    expect(response.status).toBe(200);
    const { threadId } = (await response.json()) as { threadId: string };
    expect(threadId).toBeTruthy();

    expect(capturedStart).toBeDefined();
    expect(capturedStart!.context).toContain(
      "This is a new, empty Whiteboard session.",
    );
    expect(capturedStart!.context).toContain("My Repo");
  });

  it("uses the build preamble even when a selection is also supplied", async () => {
    const reviewId = await createReview("Another Repo");
    let capturedStart: AskThreadStart | undefined;

    const api = createReviewApi(
      store,
      localData,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      makeAskHost([], (s) => {
        capturedStart = s;
      }),
    );

    const response = await api.request(`/${reviewId}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "claude",
        question: { text: "What does this do?" },
        purpose: "build",
        selection: {
          title: "Some text",
          target: { kind: "text", quote: "const x = 1;" },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(capturedStart!.context).toContain(
      "This is a new, empty Whiteboard session.",
    );
  });

  it("uses the reviewer framing (not build preamble) when purpose is absent", async () => {
    const reviewId = await createReview("Third Repo");
    let capturedStart: AskThreadStart | undefined;

    const api = createReviewApi(
      store,
      localData,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      makeAskHost([], (s) => {
        capturedStart = s;
      }),
    );

    const response = await api.request(`/${reviewId}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "claude",
        question: { text: "Explain this" },
        // no selection, no purpose
      }),
    });

    // Selection is now optional; the request must succeed.
    expect(response.status).toBe(200);
    // Normal reviewer framing, not the build preamble.
    expect(capturedStart!.context).not.toContain(
      "This is a new, empty Whiteboard session.",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. POST /asks — purpose "build" stores prompt with build preamble
// ---------------------------------------------------------------------------

describe("POST /asks with purpose build", () => {
  it("stores a prompt prefixed with the build preamble when purpose is build", async () => {
    const reviewId = await createReview("Payments Service");
    const api = createReviewApi(store);
    const userText = "Draw the login flow";

    const queued = await api.request("/asks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewId, prompt: userText, purpose: "build" }),
    });

    expect(queued.status).toBe(202);
    const { askId } = (await queued.json()) as { askId: string };

    const got = await api.request(`/asks/${askId}`);
    expect(got.status).toBe(200);
    const { ask } = (await got.json()) as { ask: { prompt: string } };

    expect(ask.prompt).toContain("This is a new, empty Whiteboard session.");
    expect(ask.prompt).toContain("Payments Service");
    expect(ask.prompt).toContain(userText);
  });

  it("stores the prompt unchanged when purpose is absent", async () => {
    const reviewId = await createReview("Repo Without Purpose");
    const api = createReviewApi(store);
    const userText = "Summarise the architecture";

    const queued = await api.request("/asks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewId, prompt: userText }),
    });

    expect(queued.status).toBe(202);
    const { askId } = (await queued.json()) as { askId: string };

    const got = await api.request(`/asks/${askId}`);
    const { ask } = (await got.json()) as { ask: { prompt: string } };

    expect(ask.prompt).toBe(userText);
  });
});

// ---------------------------------------------------------------------------
// buildSessionPrompt unit
// ---------------------------------------------------------------------------

describe("buildSessionPrompt", () => {
  it("includes the session preamble and repo label", () => {
    const result = buildSessionPrompt("Do X", "my-repo");

    expect(result).toContain("This is a new, empty Whiteboard session.");
    expect(result).toContain("my-repo");
    expect(result).toContain("Do X");
  });

  it("omits the repo line when repoLabel is not provided", () => {
    const result = buildSessionPrompt("Do X");

    expect(result).toContain("This is a new, empty Whiteboard session.");
    expect(result).toContain("Do X");
    expect(result).not.toContain("The session is for the repository:");
  });
});
