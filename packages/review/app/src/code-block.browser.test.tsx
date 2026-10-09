import * as stylex from "@stylexjs/stylex";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { scopeReviewCanvasCss } from "../desktop-css-scope";
import { RenderedCodeBlock } from "./code-block";
import { appMarker } from "./markers.stylex";
import { fontSize } from "./scale.stylex";

import canvasCss from "./styles.css?inline";

const testStyles = stylex.create({
  expectedFont: { fontSize: fontSize.ui },
});

let root: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

describe("RenderedCodeBlock", () => {
  it("uses its StyleX font size when no code size is provided", async () => {
    const styles = document.createElement("style");
    styles.textContent = scopeReviewCanvasCss(canvasCss);
    const canvasRoot = document.createElement("div");
    canvasRoot.className = "review-canvas-root";
    const canvas = document.createElement("div");
    canvas.className = `review-app ${stylex.props(appMarker).className}`;
    canvasRoot.append(canvas);
    document.body.append(styles, canvasRoot);
    root = createRoot(canvas);

    await act(async () => {
      root!.render(<RenderedCodeBlock code="const answer = 42;" />);
    });

    const pre = canvas.querySelector("pre")!;
    const expected = document.createElement("div");
    expected.className = stylex.props(testStyles.expectedFont).className!;
    canvas.append(expected);

    expect(pre.style.fontSize).toBe("");
    expect(getComputedStyle(pre).fontSize).toBe(
      getComputedStyle(expected).fontSize,
    );
  });
});
