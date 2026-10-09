import { documentSchema } from "@review/review-api/document";
import type { Snapshot } from "@review/review-api/store";
import * as stylex from "@stylexjs/stylex";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { scopeReviewCanvasCss } from "../desktop-css-scope";
import { mountReviewCanvas as mount } from "./desktop-entry";
import { fixtureReviewBridge, settled } from "./fixture-review-bridge";
import { fontSize } from "./scale.stylex";

import canvasCss from "./styles.css?inline";

const testStyles = stylex.create({
  expectedFont: { fontSize: fontSize.ui },
});

let canvas: ReturnType<typeof mount> | undefined;

afterEach(async () => {
  await act(async () => canvas?.dispose());
  canvas = undefined;
  document.body.replaceChildren();
});

describe("API canvas code font size", () => {
  it("keeps the StyleX font size when the desktop content has no code size", async () => {
    const styles = document.createElement("style");
    styles.textContent = scopeReviewCanvasCss(canvasCss);
    const container = document.createElement("div");
    document.body.append(styles, container);

    const [block] = documentSchema.parse([
      {
        id: "code",
        type: "markdown",
        markdown: ["```tsx", "const answer = 42;", "```"].join("\n"),
      },
    ]);

    const snapshot: Snapshot = {
      reviewId: "desktop-code-font-size",
      version: 0,
      title: "Desktop code font size",
      pins: { repositoryId: "repo", base: "base", head: "head" },
      target: {
        kind: "commits",
        repositoryId: "repo",
        base: "base",
        head: "head",
      },
      document: [block!],
      createdAt: "2026-10-09T00:00:00.000Z",
    };

    await act(async () => {
      canvas = mount(container, {
        kind: "api",
        reviewId: snapshot.reviewId,
        version: 0,
        bridge: fixtureReviewBridge({ snapshot }),
      });
    });

    expect(
      await settled(() =>
        container
          .querySelector("pre")
          ?.textContent?.includes("const answer = 42;"),
      ),
    ).toBe(true);

    const pre = container.querySelector("pre")!;
    const expected = document.createElement("div");
    expected.className = stylex.props(testStyles.expectedFont).className!;
    container.append(expected);

    expect(pre.style.fontSize).toBe("");
    expect(getComputedStyle(pre).fontSize).toBe(
      getComputedStyle(expected).fontSize,
    );
  });
});
