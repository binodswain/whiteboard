import { type ReactNode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ReviewDebugSettingsProvider } from "./debug-settings";
import { DiagramTourOverlay } from "./diagram-tour";
import { ReviewSessionProvider } from "./host/review-session";
import { ReviewProvider } from "./review-context";
import { ReviewPanelProvider } from "./review-panel";
import type { GuidedTour, PeekAnchor } from "./review-panel-model";
import { testReviewSession } from "./review-session-test-utils";

import "./styles.css";

let root: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
});

// The overlay portals into .review-canvas-root, outside .review-app, so it
// must carry the theme stack itself. Without it the light theme leaves the
// panel's --chrome-* vars unset, and every control that reads them falls back
// to the canvas root's dark ink: light-on-light text.
describe("Diagram tour overlay theme", () => {
  it("keeps the panel's text off the canvas's dark ink in the light theme", async () => {
    const canvas = document.createElement("div");
    canvas.className = "review-canvas-root";
    const container = document.createElement("div");
    canvas.append(container);
    document.body.append(canvas);
    root = createRoot(container);

    const session = testReviewSession(
      { theme: "light" },
      { currentTheme: () => "light" },
    );

    await act(async () => {
      renderWithSession(
        session,
        <ReviewDebugSettingsProvider>
          <ReviewProvider>
            <ReviewPanelProvider>
              <DiagramTourOverlay
                tour={tourFixture()}
                activeAnchor="first"
                revealRequest={0}
                onActiveAnchorChange={() => {}}
                onClose={() => {}}
              >
                <div>stage</div>
              </DiagramTourOverlay>
            </ReviewPanelProvider>
          </ReviewProvider>
        </ReviewDebugSettingsProvider>,
      );
      await Promise.resolve();
    });

    const overlay = container.querySelector<HTMLElement>(
      ".diagram-tour-overlay",
    )!;

    const close = overlay.querySelector<HTMLElement>(
      '[aria-label="Close guided tour"]',
    )!;

    const canvasInk = getComputedStyle(canvas).color;

    expect(getComputedStyle(overlay).color).not.toBe(canvasInk);
    expect(getComputedStyle(close).color).not.toBe(canvasInk);
  });
});

function renderWithSession(
  session: ReturnType<typeof testReviewSession>,
  node: ReactNode,
) {
  root!.render(
    <ReviewSessionProvider session={session}>{node}</ReviewSessionProvider>,
  );
}

function tourFixture(): GuidedTour {
  const first = { id: "first", title: "First" } as PeekAnchor;
  const second = { id: "second", title: "Second" } as PeekAnchor;

  return {
    id: "tour",
    stops: [
      {
        anchor: first,
        label: "First",
        content: { kind: "inline-code", text: "first();" },
      },
      {
        anchor: second,
        label: "Second",
        content: { kind: "inline-code", text: "second();" },
      },
    ],
  };
}
