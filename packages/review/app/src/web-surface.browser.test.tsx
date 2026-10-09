import { flowDiagramSchema } from "@review/review-api/blocks/flow_diagram";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { AgentSelectionProvider, useAgentSelection } from "./agent-selection";
import { observeAgentTextSelection } from "./agent-text-selection";
import { ReviewDebugSettingsProvider } from "./debug-settings";
import { FlowGraph } from "./flow-graph";
import {
  type ReviewSession,
  ReviewSessionProvider,
} from "./host/review-session";
import { ReviewFindProvider } from "./review-find";
import { ReviewPanelProvider, useReviewPanelStore } from "./review-panel";
import type { ReviewPanelStore } from "./review-panel-store";
import { ReviewRootsProvider } from "./review-root-context";
import { testReviewSession } from "./review-session-test-utils";
import { offeredReviewViews } from "./review-view-route";

let root: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("offers only the whiteboard and diagrams in the web surface", () => {
  expect(
    offeredReviewViews({
      hasChangeRange: true,
      softwareMapEnabled: true,
      hasTraceSessions: true,
      surface: "web",
    }),
  ).toEqual(["review", "map"]);
});

it("opens Find with the browser command shortcut", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const articleRef = createRef<HTMLElement>();
  const shellRef = createRef<HTMLElement>();

  const roots = {
    appRef: createRef<HTMLDivElement>(),
    shellRef,
    scrollRegionRef: createRef<HTMLElement>(),
    articleRef,
  };

  await act(async () => {
    root!.render(
      <ReviewSessionProvider session={testReviewSession({ surface: "web" })}>
        <ReviewRootsProvider roots={roots}>
          <ReviewFindProvider articleRef={articleRef} documentKey="web-review">
            <main ref={shellRef}>
              <article ref={articleRef} className="review-document">
                Searchable review text
              </article>
            </main>
          </ReviewFindProvider>
        </ReviewRootsProvider>
      </ReviewSessionProvider>,
    );
  });

  const mac = /Mac|iPhone|iPad/.test(navigator.platform);

  const event = new KeyboardEvent("keydown", {
    key: "f",
    metaKey: mac,
    ctrlKey: !mac,
    cancelable: true,
  });

  await act(async () => window.dispatchEvent(event));

  expect(event.defaultPrevented).toBe(true);
  await vi.waitFor(() =>
    expect(
      container.querySelector('[role="search"][aria-label="Find in session"]'),
    ).toBeTruthy(),
  );
});

it("selects document text and opens Ask with the keyboard shortcut", async () => {
  const container = document.createElement("div");
  container.className = "review-canvas-root";
  document.body.append(container);
  root = createRoot(container);
  const session = askSession();
  let panelStore: ReviewPanelStore | undefined;

  function TextSelection() {
    const select = useAgentSelection();

    const article = (node: HTMLElement | null) => {
      if (node) observeAgentTextSelection(node, select);
    };

    return (
      <article className="review-document" ref={article}>
        <p
          data-review-copy-prose
          contentEditable
          suppressContentEditableWarning
          tabIndex={0}
        >
          Keyboard selection works
        </p>
      </article>
    );
  }

  function StoreProbe() {
    panelStore = useReviewPanelStore();

    return null;
  }

  await act(async () => {
    root!.render(
      <ReviewSessionProvider session={session}>
        <ReviewPanelProvider>
          <StoreProbe />
          <AgentSelectionProvider revision="current">
            <TextSelection />
          </AgentSelectionProvider>
        </ReviewPanelProvider>
      </ReviewSessionProvider>,
    );
  });

  await userEvent.tab();
  await userEvent.keyboard("{Home}{Shift>}{End}{/Shift}");
  await vi.waitFor(() => expect(container.textContent).toContain("Ask Codex"));
  await userEvent.keyboard(askShortcut());

  await vi.waitFor(() => expect(panelStore?.getState().asks).toHaveLength(1));
  expect(panelStore?.getState().asks[0]?.view).toMatchObject({
    selection: {
      target: { kind: "text", quote: "Keyboard selection works" },
    },
  });
});

it("selects a flow diagram node with Enter and asks about its code", async () => {
  const container = document.createElement("div");
  container.className = "review-canvas-root";
  document.body.append(container);
  root = createRoot(container);
  const session = askSession();
  let panelStore: ReviewPanelStore | undefined;

  const block = flowDiagramSchema.parse({
    type: "flow_diagram",
    title: "Request flow",
    nodes: [{ key: "handler", label: "Request handler" }],
    edges: [],
  });

  function StoreProbe() {
    panelStore = useReviewPanelStore();

    return null;
  }

  function SelectableFlow() {
    const select = useAgentSelection();

    return (
      <ReviewDebugSettingsProvider>
        <FlowGraph
          block={block}
          onSelect={(node) =>
            select({
              title: node.label,
              target: {
                kind: "code",
                path: "src/handler.ts",
                side: "head",
                startLine: 4,
                endLine: 8,
              },
            })
          }
        />
      </ReviewDebugSettingsProvider>
    );
  }

  await act(async () => {
    root!.render(
      <ReviewSessionProvider session={session}>
        <ReviewPanelProvider>
          <StoreProbe />
          <AgentSelectionProvider revision="current">
            <SelectableFlow />
          </AgentSelectionProvider>
        </ReviewPanelProvider>
      </ReviewSessionProvider>,
    );
  });

  const node = await vi.waitFor(() => {
    const candidate = container.querySelector<HTMLElement>(
      '[aria-label="Request handler"]',
    );

    expect(candidate).toBeTruthy();

    return candidate!;
  });

  node.focus();
  expect(document.activeElement).toBe(node);
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard(askShortcut());

  await vi.waitFor(() => expect(panelStore?.getState().asks).toHaveLength(1));
  expect(panelStore?.getState().asks[0]?.view).toMatchObject({
    selection: {
      target: {
        kind: "code",
        path: "src/handler.ts",
        side: "head",
        startLine: 4,
        endLine: 8,
      },
    },
  });
});

function askSession(): ReviewSession {
  const session = testReviewSession({ reviewId: "web-review", surface: "web" });
  vi.spyOn(session, "fetch").mockImplementation(async (endpoint) => {
    if (endpoint === "/ask/agents")
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

    return Response.json({});
  });

  return session;
}

function askShortcut(): string {
  return /Mac|iPhone|iPad/.test(navigator.platform)
    ? "{Meta>}l{/Meta}"
    : "{Control>}l{/Control}";
}
