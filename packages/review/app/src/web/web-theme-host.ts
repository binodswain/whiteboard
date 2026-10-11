import { appMarker } from "@canvas/markers.stylex";
import { themeStyles } from "@canvas/theme-styles";
import * as stylex from "@stylexjs/stylex";

import { readCachedTheme, resolveTheme } from "./theme-cache";

/**
 * Where a web screen outside the review canvas renders (the token prompt, the
 * toast stack). It carries the canvas's palette tokens for the theme this
 * browser last saw, so those screens read like the rest of the app.
 *
 * The scoped stylesheet cannot style its own scope root, so the token classes
 * sit on `host`, inside whichever element is the `.review-canvas-root`: the
 * given `scope` when it already is one, or a new `root` otherwise. The theme
 * is mirrored on that scope element for anything that observes it.
 */
export function createWebThemeHost(
  scope: HTMLElement | null,
  document: Document,
) {
  const light = resolveTheme(readCachedTheme()) === "light";
  const root = scope ?? document.createElement("div");
  const host = document.createElement("div");

  if (!scope) root.classList.add("review-canvas-root");

  root.dataset.reviewTheme = light ? "light" : "dark";
  host.className = [
    light && "review-app--theme-light",
    stylex.props(appMarker, themeStyles.vars, light && themeStyles.light)
      .className,
  ]
    .filter(Boolean)
    .join(" ");
  host.style.display = "contents";
  root.append(host);

  return { root, host };
}
