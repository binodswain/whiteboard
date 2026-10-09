import type {
  ReviewApiSummary,
  ReviewCanvasBridge,
} from "@dev.fast/review-protocol";
import {
  assignFreshIds,
  documentSchema,
} from "@review/review-api/document";
import type { Snapshot } from "@review/review-api/store";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { fixtureReviewBridge, settled } from "@canvas/fixture-review-bridge";

import { type WebAppHandle, startWebCanvas } from "./web-app";

interface FixtureState {
  catalog: ReviewApiSummary[];
  snapshots: Map<string, Snapshot>;
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

    if (pathname === "/reviews-api") return Response.json(state.catalog);

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

  return { request, push };
}

function fixtureReview(
  reviewId: string,
  title: string,
): Snapshot {
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
    target: { kind: "commits", repositoryId: "repo", base: "base", head: "head" },
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
      snapshots: new Map([[snapshot.reviewId, snapshot]]),
    };

    const { request, push } = webFixtureRequest(state);

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

    // A review published after load appears without a reload.
    const added = fixtureReview("web-review-2", "Published later");

    state.snapshots.set(added.reviewId, added);
    state.catalog = [...state.catalog, summaryOf(added)];

    await act(async () => push());

    expect(
      await settled(() =>
        container!.textContent?.includes("Published later"),
      ),
    ).toBe(true);

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
  });
});
