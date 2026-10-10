import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { AgentSelectionProvider, useAgentSelection } from "./agent-selection";
import { ReviewDebugSettingsProvider } from "./debug-settings";
import { ReviewSessionProvider } from "./host/review-session";
import { testReviewSession } from "./review-session-test-utils";

import "./styles.css";

let root: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
});

// A selection outside the document portals its toolbar straight onto
// .review-canvas-root, outside .review-app: the lane has to carry the theme
// itself or the light theme leaves it the dark palette's popover and ink.
describe("Agent selection toolbar theme", () => {
  it("keeps a canvas-rooted toolbar off the dark ink in the light theme", async () => {
    const canvas = document.createElement("div");
    canvas.className = "review-canvas-root";
    canvas.style.cssText = "position:fixed;inset:0;";
    const filler = document.createElement("div");
    filler.style.cssText = "position:absolute;inset:0;";
    const container = document.createElement("div");
    canvas.append(filler, container);
    document.body.append(canvas);
    root = createRoot(container);

    const session = testReviewSession(
      { theme: "light" },
      { currentTheme: () => "light" },
    );

    function Pick() {
      const select = useAgentSelection();

      return (
        <button
          onClick={() =>
            select({
              title: "Ref",
              anchor: { x: 40, y: 40 },
              target: { kind: "text", quote: "selected" },
            })
          }
        >
          Select
        </button>
      );
    }

    await act(async () => {
      root!.render(
        <ReviewSessionProvider session={session}>
          <ReviewDebugSettingsProvider>
            <AgentSelectionProvider revision="current">
              <Pick />
            </AgentSelectionProvider>
          </ReviewDebugSettingsProvider>
        </ReviewSessionProvider>,
      );
    });

    await act(async () => {
      container.querySelector("button")!.click();
    });

    const canvasInk = getComputedStyle(canvas).color;
    const copy = canvas.querySelector<HTMLElement>('[aria-label="Copy ref"]')!;

    expect(getComputedStyle(copy.parentElement!).color).not.toBe(canvasInk);
    expect(getComputedStyle(copy).color).not.toBe(canvasInk);
  });
});
