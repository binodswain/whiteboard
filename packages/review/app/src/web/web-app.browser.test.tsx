import { fixtureReviewBridge, settled } from "@canvas/fixture-review-bridge";
import type {
  ReviewApiSummary,
  ReviewCanvasBridge,
} from "@dev.fast/review-protocol";
import { assignFreshIds, documentSchema } from "@review/review-api/document";
import type { Snapshot } from "@review/review-api/store";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { type WebAppHandle, startWebCanvas } from "./web-app";

interface FixtureState {
  catalog: ReviewApiSummary[];
  repositories: { id: string; name: string }[];
  snapshots: Map<string, Snapshot>;
  createStatus?: number;
  createError?: string;
  deploymentMode?: "local" | "remote";
}

interface WatchStream {
  subscriptions: { reviewId: string | null }[];
  controller: ReadableStreamDefaultController<Uint8Array>;
}

const ACTIVITY = { workingCount: 0, expiresAt: null };

function summaryOf(snapshot: Snapshot): ReviewApiSummary {
  return {
    reviewId: snapshot.reviewId,
    version: snapshot.version,
    title: snapshot.title,
    repositoryName: "fixture",
    createdAt: snapshot.createdAt,
    viewedAt: null,
    dismissedAt: null,
  };
}

/**
 * Answers the review API the web canvas reads: the catalog, one multiplexed
 * NDJSON watch stream per open connection, and the per-review routes the
 * fixture bridge knows.
 */
function webFixtureRequest(state: FixtureState) {
  const encoder = new TextEncoder();
  const streams = new Set<WatchStream>();
  const delegates = new Map<string, ReviewCanvasBridge["request"]>();
  const createCalls: { body: unknown; token: string | null }[] = [];
  const askCalls: { path: string; body: unknown }[] = [];

  let settings = {
    theme: "system",
    documentWidth: "standard",
    codeFontSize: 14,
    softwareMapEnabled: false,
    structuralDiffEnabled: false,
    scratchpadEnabled: false,
  };

  let settingsReads = 0;

  const delegate = (reviewId: string) => {
    let request = delegates.get(reviewId);
    const snapshot = state.snapshots.get(reviewId);

    if (!request && snapshot) {
      request = fixtureReviewBridge({ snapshot }).request;
      delegates.set(reviewId, request);
    }

    return request;
  };

  const values = (stream: WatchStream) =>
    stream.subscriptions.map(({ reviewId }) => {
      if (reviewId === null) return { value: state.catalog };

      const snapshot = state.snapshots.get(reviewId);

      return snapshot
        ? {
            value: {
              ...snapshot,
              activity: ACTIVITY,
              coverageRevision: 0,
            },
          }
        : { error: "Could not read review." };
    });

  const emit = (stream: WatchStream) => {
    try {
      stream.controller.enqueue(
        encoder.encode(`${JSON.stringify(values(stream))}\n`),
      );
    } catch {
      // The reader cancelled between selection and enqueue.
      streams.delete(stream);
    }
  };

  const push = () => {
    for (const stream of streams) emit(stream);
  };

  const request = async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const { pathname, searchParams } = new URL(url);

    if (pathname === "/reviews-api/settings") {
      if (init?.method === "PUT") {
        settings = { ...settings, ...JSON.parse(String(init.body)) };

        return Response.json(settings);
      }

      settingsReads += 1;

      return Response.json(settings);
    }

    if (pathname === "/diffr-config")
      return Response.json({ values: {}, credentialSource: "missing" });

    if (pathname === "/reviews-api/status")
      return Response.json({
        deployment: { mode: state.deploymentMode ?? "local" },
      });

    if (pathname === "/reviews-api/ask/agents")
      return Response.json({
        agents: [
          {
            id: "codex",
            name: "Codex",
            available: true,
            readOnly: true,
            bypass: false,
          },
        ],
      });

    if (
      (pathname === "/reviews-api/asks" ||
        /^\/reviews-api\/[^/]+\/ask$/.test(pathname)) &&
      init?.method === "POST"
    ) {
      askCalls.push({ path: pathname, body: JSON.parse(String(init.body)) });

      return Response.json({ ok: true });
    }

    if (pathname === "/reviews-api") return Response.json(state.catalog);

    if (pathname === "/reviews-api/repositories")
      return Response.json(state.repositories);

    if (pathname === "/reviews-api/commands" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        operation: {
          title: string;
          target: { repositoryId: string };
        };
      };

      createCalls.push({
        body,
        token: new Headers(init.headers).get("x-review-token"),
      });

      if (state.createStatus)
        return Response.json(
          { error: state.createError ?? "Could not create session." },
          { status: state.createStatus },
        );

      const operation = body.operation;

      const repository = state.repositories.find(
        (entry) => entry.id === operation.target.repositoryId,
      );

      const snapshot = fixtureReview("web-created-session", operation.title);

      const review: ReviewApiSummary = {
        ...summaryOf(snapshot),
        repositoryName: repository?.name ?? "fixture",
        target: {
          kind: "worktree",
          repositoryId: operation.target.repositoryId,
        },
      };

      state.snapshots.set(snapshot.reviewId, snapshot);
      state.catalog = [...state.catalog, review];
      push();

      return Response.json({
        reviewId: review.reviewId,
        version: 0,
        created: true,
        review,
        opened: false,
      });
    }

    if (pathname === "/reviews-api/watch") {
      const subscriptions = JSON.parse(
        searchParams.get("subscriptions") ?? "[]",
      ) as WatchStream["subscriptions"];

      let entry: WatchStream | undefined;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const record: WatchStream = { subscriptions, controller };

          entry = record;
          streams.add(record);
          emit(record);
          init?.signal?.addEventListener("abort", () => {
            streams.delete(record);
          });
        },
        cancel() {
          if (entry) streams.delete(entry);
        },
      });

      return new Response(stream, {
        headers: { "content-type": "application/x-ndjson" },
      });
    }

    const review = /^\/reviews-api\/([^/]+)/.exec(pathname)?.[1];
    const pass = review ? delegate(decodeURIComponent(review)) : undefined;

    return pass
      ? pass(url, init)
      : Response.json({ error: `No fixture for ${pathname}` }, { status: 404 });
  };

  const activeCatalogWatches = () =>
    [...streams].filter((stream) =>
      stream.subscriptions.some(({ reviewId }) => reviewId === null),
    ).length;

  return {
    request,
    push,
    createCalls,
    askCalls,
    activeCatalogWatches,
    settingsReads: () => settingsReads,
    settingsValues: () => settings,
  };
}

function fixtureReview(reviewId: string, title: string): Snapshot {
  const blocks = documentSchema.parse([
    {
      type: "flow_diagram",
      title: "Queue an order",
      nodes: [
        {
          key: "request",
          label: "Queue order",
          attachments: [{ label: "Handler", sources: ["head/order.ts#L1"] }],
        },
        { key: "saved", label: "Saved", kind: "terminal", attachments: [] },
      ],
      edges: [{ from: "request", to: "saved", label: "persist" }],
    },
  ]);

  let nextId = 0;

  for (const block of blocks)
    assignFreshIds(block, (prefix) => `${prefix}-${++nextId}`);

  return {
    reviewId,
    version: 1,
    title,
    pins: { repositoryId: "repo", base: "base", head: "head" },
    target: {
      kind: "commits",
      repositoryId: "repo",
      base: "base",
      head: "head",
    },
    document: blocks,
    createdAt: "2026-01-05T00:00:00.000Z",
  };
}

describe("the web canvas entry", () => {
  let container: HTMLElement | undefined;
  let app: WebAppHandle | undefined;

  afterEach(async () => {
    await act(async () => app?.dispose());
    app = undefined;
    container?.remove();
    container = undefined;
    history.replaceState(null, "", "/");
    sessionStorage.clear();
    localStorage.clear();
  });

  it("lists the catalog on Home and opens a review, with diagrams rendering", async () => {
    const snapshot = fixtureReview("web-review-1", "Fixture review");

    const state: FixtureState = {
      catalog: [summaryOf(snapshot)],
      repositories: [{ id: "repo", name: "fixture" }],
      snapshots: new Map([[snapshot.reviewId, snapshot]]),
    };

    const {
      request,
      push,
      activeCatalogWatches,
      settingsReads,
      settingsValues,
    } = webFixtureRequest(state);

    history.replaceState(null, "", "/");
    container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      app = startWebCanvas(container!, {
        token: "test",
        serverUrl: "http://fixture.local",
        request,
      });
    });

    // Home lists the catalog read.
    expect(
      await settled(() => container!.textContent?.includes("Fixture review")),
    ).toBe(true);
    expect(await settled(() => activeCatalogWatches() === 1)).toBe(true);

    await act(async () => {
      container!
        .querySelector<HTMLElement>('[aria-label="Open Settings"]')!
        .click();
    });
    expect(location.pathname).toBe("/settings");
    expect(container!.textContent).toContain("Structural Diffs");
    expect(container!.textContent).toContain(
      "Settings apply to Whiteboard on this machine.",
    );
    expect(
      container!.querySelector<HTMLInputElement>(
        'input[aria-label="Scratchpad"]',
      ),
    ).not.toBeNull();
    expect(settingsReads()).toBe(1);

    await act(async () => {
      [
        ...container!.querySelectorAll<HTMLButtonElement>(
          '[role="radiogroup"][aria-label="Theme"] [role="radio"]',
        ),
      ]
        .find((button) => button.textContent === "Dark")
        ?.click();
    });
    await settled(() => settingsValues().theme === "dark");

    await act(async () => {
      [
        ...container!.querySelectorAll<HTMLButtonElement>(
          '[role="radiogroup"][aria-label="Document width"] [role="radio"]',
        ),
      ]
        .find((button) => button.textContent === "Wide")
        ?.click();
    });
    await settled(() => settingsValues().documentWidth === "wide");

    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('button[aria-label="Go back"]')!
        .click();
    });
    expect(location.pathname).toBe("/");

    // A review published after load appears without a reload.
    const added = fixtureReview("web-review-2", "Published later");

    state.snapshots.set(added.reviewId, added);
    state.catalog = [...state.catalog, summaryOf(added)];

    await act(async () => push());

    expect(
      await settled(() => container!.textContent?.includes("Published later")),
    ).toBe(true);

    const search = container!.querySelector<HTMLInputElement>(
      '[aria-label="Search sessions"]',
    )!;

    await act(async () => userEvent.fill(search, "review"));

    expect(search.value).toBe("review");
    expect(container!.textContent).toContain("Fixture review");
    expect(container!.textContent).not.toContain("Published later");

    // Opening a review routes to /r/:id and renders its flow diagram.
    const row = [...container!.querySelectorAll("tbody tr")].find((tr) =>
      tr.textContent?.includes("Fixture review"),
    )!;

    await act(async () => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(location.pathname).toBe("/r/web-review-1");
    expect(
      await settled(
        () => container!.querySelectorAll(".react-flow__edge").length > 0,
      ),
    ).toBe(true);
    expect(container!.textContent).toContain("Queue order");
    expect(await settled(() => activeCatalogWatches() === 0)).toBe(true);

    // The brand bar's wordmark is the way out of a session: back to Home.
    await act(async () => {
      container!
        .querySelector<HTMLAnchorElement>('a[aria-label="Whiteboard home"]')!
        .click();
    });
    expect(location.pathname).toBe("/");
    expect(
      await settled(() => container!.textContent?.includes("Fixture review")),
    ).toBe(true);

    history.back();
    expect(await settled(() => location.pathname === "/r/web-review-1")).toBe(
      true,
    );
    expect(
      await settled(
        () => container!.querySelectorAll(".react-flow__edge").length > 0,
      ),
    ).toBe(true);

    history.back();
    expect(await settled(() => location.pathname === "/")).toBe(true);
    expect(
      await settled(
        () =>
          container!.querySelector<HTMLInputElement>(
            '[aria-label="Search sessions"]',
          )?.value === "review",
      ),
    ).toBe(true);
    expect(await settled(() => activeCatalogWatches() === 1)).toBe(true);

    history.forward();
    expect(await settled(() => location.pathname === "/r/web-review-1")).toBe(
      true,
    );
    expect(await settled(() => activeCatalogWatches() === 0)).toBe(true);
    expect(
      container!.querySelector<HTMLElement>(".review-app")?.dataset
        .documentWidth,
    ).toBe("wide");
    expect(
      container!.querySelector<HTMLElement>(".review-app")?.className,
    ).toContain("review-app--theme-dark");
  });

  it("returns from Settings to the session that opened it", async () => {
    const snapshot = fixtureReview("web-review-1", "Fixture review");

    const state: FixtureState = {
      catalog: [summaryOf(snapshot)],
      repositories: [{ id: "repo", name: "fixture" }],
      snapshots: new Map([[snapshot.reviewId, snapshot]]),
    };

    const { request } = webFixtureRequest(state);

    history.replaceState(null, "", "/r/web-review-1");
    container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      app = startWebCanvas(container!, {
        token: "test",
        serverUrl: "http://fixture.local",
        request,
      });
    });

    expect(
      await settled(
        () => container!.querySelectorAll(".react-flow__edge").length > 0,
      ),
    ).toBe(true);

    await act(async () => {
      container!
        .querySelector<HTMLAnchorElement>('a[aria-label="Open Settings"]')!
        .click();
    });
    expect(location.pathname).toBe("/settings");
    expect(
      await settled(() =>
        container!.textContent?.includes(
          "Settings apply to Whiteboard on this machine.",
        ),
      ),
    ).toBe(true);

    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('button[aria-label="Go back"]')!
        .click();
    });
    expect(location.pathname).toBe("/r/web-review-1");
  });

  it("announces initial loading and renders the empty home when ready", async () => {
    const state: FixtureState = {
      catalog: [],
      repositories: [],
      snapshots: new Map(),
    };

    const fixture = webFixtureRequest(state);
    const response = Promise.withResolvers<Response>();

    const request = (url: string, init?: RequestInit) =>
      new URL(url).pathname === "/reviews-api"
        ? response.promise
        : fixture.request(url, init);

    history.replaceState(null, "", "/");
    container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      app = startWebCanvas(container!, {
        token: "test-token",
        serverUrl: "http://fixture.local",
        request,
      });
    });

    expect(
      await settled(() => container!.textContent?.includes("Loading sessions")),
    ).toBe(true);

    await act(async () => response.resolve(Response.json([])));
    expect(
      await settled(() => container!.textContent?.includes("No sessions yet")),
    ).toBe(true);
  });

  it("recovers from a catalog error using the visible retry action", async () => {
    const state: FixtureState = {
      catalog: [],
      repositories: [],
      snapshots: new Map(),
    };

    const fixture = webFixtureRequest(state);
    let fail = true;

    const request = (url: string, init?: RequestInit) => {
      if (new URL(url).pathname === "/reviews-api" && fail) {
        fail = false;

        return Promise.resolve(
          Response.json({ error: "Catalog unavailable." }, { status: 503 }),
        );
      }

      return fixture.request(url, init);
    };

    history.replaceState(null, "", "/");
    container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      app = startWebCanvas(container!, {
        token: "test-token",
        serverUrl: "http://fixture.local",
        request,
      });
    });

    expect(
      await settled(() =>
        container!.textContent?.includes("Catalog unavailable."),
      ),
    ).toBe(true);

    await act(async () =>
      userEvent.click(
        [...container!.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "Retry",
        )!,
      ),
    );

    expect(
      await settled(() => container!.textContent?.includes("No sessions yet")),
    ).toBe(true);
  });

  it("creates a worktree session for the selected repository and opens it", async () => {
    const state: FixtureState = {
      catalog: [],
      repositories: [{ id: "repo", name: "fixture" }],
      snapshots: new Map(),
    };

    const fixture = webFixtureRequest(state);

    history.replaceState(null, "", "/");
    container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      app = startWebCanvas(container!, {
        token: "test-token",
        serverUrl: "http://fixture.local",
        request: fixture.request,
      });
    });

    expect(
      await settled(() => container!.textContent?.includes("No sessions yet")),
    ).toBe(true);

    await act(async () =>
      userEvent.click(
        [...container!.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "New session",
        )!,
      ),
    );

    const dialog = container!.querySelector('[role="dialog"]')!;

    const title = dialog.querySelector<HTMLInputElement>(
      'input[name="title"]',
    )!;

    const repository = dialog.querySelector<HTMLSelectElement>(
      'select[name="repositoryId"]',
    )!;

    await act(async () => userEvent.fill(title, "Checkout review"));
    await act(async () => userEvent.selectOptions(repository, "repo"));
    await act(async () =>
      userEvent.click(
        [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "Create session",
        )!,
      ),
    );

    expect(
      await settled(() => location.pathname === "/r/web-created-session"),
    ).toBe(true);
    expect(fixture.createCalls).toHaveLength(1);
    expect(fixture.askCalls).toHaveLength(0);
    expect(fixture.createCalls[0]).toMatchObject({
      token: "test-token",
      body: {
        operation: {
          type: "create",
          title: "Checkout review",
          target: { kind: "worktree", repositoryId: "repo" },
          open: false,
        },
      },
    });

    history.back();
    expect(await settled(() => location.pathname === "/")).toBe(true);
    expect(
      await settled(() => container!.textContent?.includes("Checkout review")),
    ).toBe(true);
  });

  it.each([
    {
      mode: "local" as const,
      path: "/reviews-api/web-created-session/ask",
      body: {
        agent: "codex",
        question: { text: "Build a board" },
        purpose: "build",
      },
    },
    {
      mode: "remote" as const,
      path: "/reviews-api/asks",
      body: {
        reviewId: "web-created-session",
        prompt: "Build a board",
        purpose: "build",
      },
    },
  ])("starts a session task in $mode mode", async ({ mode, path, body }) => {
    const fixture = webFixtureRequest({
      catalog: [],
      repositories: [{ id: "repo", name: "fixture" }],
      snapshots: new Map(),
      deploymentMode: mode === "remote" ? "remote" : "local",
    });

    history.replaceState(null, "", "/");
    container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      app = startWebCanvas(container!, {
        token: "test-token",
        serverUrl: "http://fixture.local",
        request: fixture.request,
      });
    });

    expect(
      await settled(() => container!.textContent?.includes("No sessions yet")),
    ).toBe(true);
    await act(async () =>
      userEvent.click(
        [...container!.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "New session",
        )!,
      ),
    );
    const dialog = container!.querySelector('[role="dialog"]')!;
    await act(async () =>
      userEvent.fill(
        dialog.querySelector<HTMLInputElement>('input[name="title"]')!,
        "Task session",
      ),
    );
    await act(async () =>
      userEvent.selectOptions(
        dialog.querySelector<HTMLSelectElement>('select[name="repositoryId"]')!,
        "repo",
      ),
    );
    await act(async () =>
      userEvent.fill(
        dialog.querySelector<HTMLTextAreaElement>('textarea[name="task"]')!,
        "Build a board",
      ),
    );
    await act(async () =>
      userEvent.click(
        [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "Create session",
        )!,
      ),
    );

    expect(
      await settled(() => location.pathname === "/r/web-created-session"),
    ).toBe(true);
    expect(fixture.askCalls).toEqual([{ path, body }]);
  });

  it("keeps session creation unavailable until a repository is registered", async () => {
    const state: FixtureState = {
      catalog: [],
      repositories: [],
      snapshots: new Map(),
    };

    const fixture = webFixtureRequest(state);

    history.replaceState(null, "", "/");
    container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      app = startWebCanvas(container!, {
        token: "test-token",
        serverUrl: "http://fixture.local",
        request: fixture.request,
      });
    });

    expect(
      await settled(() => container!.textContent?.includes("No sessions yet")),
    ).toBe(true);
    expect(container!.textContent).toContain("Register a repository");
    expect(
      [...container!.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "New session",
      )?.disabled,
    ).toBe(true);
    expect(fixture.createCalls).toHaveLength(0);
  });

  it.each([
    { status: 400, error: "Select a registered repository." },
    { status: 500, error: "Session creation is unavailable." },
    { status: 401, error: "Authentication required." },
  ])(
    "keeps the new-session dialog actionable after API status $status",
    async ({ status, error }) => {
      const fixture = webFixtureRequest({
        catalog: [],
        repositories: [{ id: "repo", name: "fixture" }],
        snapshots: new Map(),
        createStatus: status,
        createError: error,
      });

      history.replaceState(null, "", "/");
      container = document.createElement("div");
      document.body.append(container);

      await act(async () => {
        app = startWebCanvas(container!, {
          token: "test-token",
          serverUrl: "http://fixture.local",
          request: fixture.request,
        });
      });

      expect(
        await settled(() =>
          container!.textContent?.includes("No sessions yet"),
        ),
      ).toBe(true);
      await act(async () =>
        userEvent.click(
          [...container!.querySelectorAll<HTMLButtonElement>("button")].find(
            (button) => button.textContent === "New session",
          )!,
        ),
      );

      const dialog = container!.querySelector('[role="dialog"]')!;
      await act(async () =>
        userEvent.fill(
          dialog.querySelector<HTMLInputElement>('input[name="title"]')!,
          "Checkout review",
        ),
      );
      await act(async () =>
        userEvent.selectOptions(
          dialog.querySelector<HTMLSelectElement>(
            'select[name="repositoryId"]',
          )!,
          "repo",
        ),
      );
      await act(async () =>
        userEvent.click(
          [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
            (button) => button.textContent === "Create session",
          )!,
        ),
      );

      expect(
        await settled(
          () => dialog.querySelector('[role="alert"]')?.textContent === error,
        ),
      ).toBe(true);
      expect(container!.querySelector('[role="dialog"]')).not.toBeNull();
      expect(fixture.createCalls[0]?.token).toBe("test-token");
    },
  );

  it("skips the token prompt only when the server advertises local browser auth", async () => {
    const state: FixtureState = {
      catalog: [],
      repositories: [],
      snapshots: new Map(),
    };

    const fixture = webFixtureRequest(state);
    const requested: string[] = [];

    const request = async (url: string, init?: RequestInit) => {
      const { pathname } = new URL(url);

      requested.push(pathname);

      if (pathname === "/reviews-api/capabilities")
        return Response.json({ localBrowserAuth: true });

      return fixture.request(url, init);
    };

    history.replaceState(null, "", "/");
    container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      app = startWebCanvas(container!, { request });
    });

    expect(await settled(() => requested.includes("/reviews-api"))).toBe(true);
    expect(container.querySelector("input[type=password]")).toBeNull();
  });

  it("opens a returned session URL and renders that session", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";

    const snapshot = fixtureReview(sessionId, "Headless URL review");

    const state: FixtureState = {
      catalog: [summaryOf(snapshot)],
      repositories: [],
      snapshots: new Map([[sessionId, snapshot]]),
    };

    const { request } = webFixtureRequest(state);

    history.replaceState(
      null,
      "",
      `/r/${encodeURIComponent(sessionId)}#token=abcd1234abcd1234abcd1234`,
    );
    container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      app = startWebCanvas(container!, { request });
    });

    expect(location.hash).toBe("");
    expect(sessionStorage.getItem("review-token")).toBe(
      "abcd1234abcd1234abcd1234",
    );
    expect(
      await settled(
        () => container!.querySelectorAll(".react-flow__edge").length > 0,
      ),
    ).toBe(true);
    expect(container!.textContent).toContain("Queue order");
  });

  it("bootstraps the token from the URL fragment and asks for one when missing", async () => {
    const state: FixtureState = {
      catalog: [],
      repositories: [],
      snapshots: new Map(),
    };

    const fixture = webFixtureRequest(state);
    const requested: string[] = [];

    const request = (url: string, init?: RequestInit) => {
      const { pathname } = new URL(url);

      requested.push(pathname);

      return pathname === "/reviews-api/capabilities"
        ? Promise.resolve(Response.json({ localBrowserAuth: false }))
        : fixture.request(url, init);
    };

    // No token anywhere: a short prompt, not a stack trace or a blank page.
    history.replaceState(null, "", "/");
    container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      app = startWebCanvas(container!, { request });
    });

    expect(await settled(() => container!.textContent?.includes("token"))).toBe(
      true,
    );
    expect(container.querySelector("input[type=password]")).toBeTruthy();
    // Only the probes run; no review data is read without a token.
    expect(requested).toEqual(["/auth/session", "/reviews-api/capabilities"]);

    await act(async () => app?.dispose());
    container.replaceChildren();

    // The fragment bootstrap: captured, kept in sessionStorage, stripped.
    requested.length = 0;
    history.replaceState(null, "", "/#token=abcd1234abcd1234abcd1234");

    await act(async () => {
      app = startWebCanvas(container!, { request });
    });

    expect(location.hash).toBe("");
    expect(sessionStorage.getItem("review-token")).toBe(
      "abcd1234abcd1234abcd1234",
    );
    expect(await settled(() => requested.includes("/reviews-api"))).toBe(true);
    expect(requested).not.toContain("/reviews-api/capabilities");
  });
});
