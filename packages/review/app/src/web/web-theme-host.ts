import { appMarker } from "@canvas/markers.stylex";
import { themeStyles } from "@canvas/theme-styles";
import * as stylex from "@stylexjs/stylex";

import { readCachedTheme, resolveTheme } from "./theme-cache";

/**
 * The element a web screen outside the review canvas renders into (the token
 * prompt, the toast stack): it carries the canvas's palette tokens for the
 * theme this browser last saw, so those screens read like the rest of the app.
 */
export function createWebThemeHost(
  document: Document,
  options: { displayContents?: boolean } = {},
): HTMLElement {
  const host = document.createElement("div");
  const light = resolveTheme(readCachedTheme()) === "light";

  host.className = [
    "review-canvas-root",
    light && "review-app--theme-light",
    stylex.props(appMarker, themeStyles.vars, light && themeStyles.light)
      .className,
  ]
    .filter(Boolean)
    .join(" ");
  host.dataset.reviewTheme = light ? "light" : "dark";

  if (options.displayContents) host.style.display = "contents";

  return host;
}
