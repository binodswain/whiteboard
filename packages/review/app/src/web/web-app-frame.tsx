import { fontWeight } from "@canvas/scale.stylex";
import { themeStyles } from "@canvas/theme-styles";
import { tokens } from "@canvas/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { MouseEvent, ReactElement } from "react";
import { createRoot } from "react-dom/client";

export interface WebAppFrameProps {
  /** The crumb after the wordmark: a page name or the session title. */
  context?: string | null;
  /** Client-side router; standalone mounts like /setup keep plain links. */
  onNavigate?: (path: string) => void;
}

export interface WebAppFrame {
  /** The element page content mounts into: canvas, setup, or token prompt. */
  page: HTMLElement;
  update(props: WebAppFrameProps): void;
  dispose(): void;
}

/**
 * The web app's brand bar: the wordmark links Home, a crumb names the current
 * page or session, and Settings is the one global action on the right.
 */
export function WebAppBar({
  context,
  onNavigate,
}: WebAppFrameProps): ReactElement {
  const follow = (path: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      !onNavigate ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    onNavigate(path);
  };

  return (
    <header {...stylex.props(styles.bar)}>
      <a
        href="/"
        aria-label="Whiteboard home"
        {...stylex.props(styles.brand)}
        onClick={follow("/")}
      >
        Whiteboard
      </a>
      {context ? (
        <span {...stylex.props(styles.crumb)}>
          <span aria-hidden="true" {...stylex.props(styles.crumbSeparator)}>
            /
          </span>
          <span {...stylex.props(styles.crumbText)} title={context}>
            {context}
          </span>
        </span>
      ) : null}
      <span {...stylex.props(styles.spacer)} />
      <a
        href="/settings"
        aria-label="Open Settings"
        aria-current={context === "Settings" ? "page" : undefined}
        {...stylex.props(
          styles.navLink,
          context === "Settings" && styles.navLinkCurrent,
        )}
        onClick={follow("/settings")}
      >
        Settings
      </a>
    </header>
  );
}

/**
 * Mounts the brand bar above a page host inside one scoped root. The page
 * keeps owning the theme through `data-review-theme`; the bar mirrors it the
 * way the setup link does, so every web screen shares the same chrome.
 */
export function mountWebAppFrame(container: HTMLElement): WebAppFrame {
  const document = container.ownerDocument;

  const body = document.createElement("div");
  body.className = "review-canvas-root";
  body.style.cssText = "display:flex;flex-direction:column;";

  const barHost = document.createElement("div");
  const page = document.createElement("div");
  page.style.cssText = "flex:1;min-height:0;";
  body.append(barHost, page);
  container.appendChild(body);

  const applyTheme = () => {
    const light = page.dataset.reviewTheme === "light";

    barHost.className = [
      light && "review-app--theme-light",
      stylex.props(themeStyles.vars, light && themeStyles.light).className,
    ]
      .filter(Boolean)
      .join(" ");
  };

  const observer = new MutationObserver(applyTheme);
  observer.observe(page, {
    attributes: true,
    attributeFilter: ["data-review-theme"],
  });
  applyTheme();

  const root = createRoot(barHost);
  let disposed = false;
  let props: WebAppFrameProps = {};

  const render = () => root.render(<WebAppBar {...props} />);
  render();

  return {
    page,
    update(next) {
      if (disposed) return;
      props = { ...props, ...next };
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      root.unmount();
      body.remove();
    },
  };
}

const styles = stylex.create({
  bar: {
    display: "flex",
    flex: "0 0 auto",
    alignItems: "center",
    gap: "8px",
    height: tokens.reviewHeaderHeight,
    padding: "0 12px 0 16px",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: tokens.rule,
    backgroundColor: tokens.surface,
    color: tokens.chromeFg,
    fontFamily: tokens.chromeFont,
    fontSize: tokens.chromeFontSize,
  },
  brand: {
    display: "inline-flex",
    alignItems: "center",
    height: tokens.chromeControlHeight,
    marginLeft: "-8px",
    padding: "0 8px",
    borderRadius: tokens.chromeControlRadius,
    backgroundColor: {
      default: tokens.transparent,
      ":hover": tokens.chromeHoverBg,
    },
    color: tokens.chromeFg,
    fontWeight: fontWeight.semibold,
    textDecoration: "none",
  },
  crumb: {
    display: "inline-flex",
    minWidth: 0,
    alignItems: "center",
    gap: "8px",
  },
  crumbSeparator: {
    color: tokens.inkFaint,
  },
  crumbText: {
    overflow: "hidden",
    color: tokens.inkMuted,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  spacer: {
    flex: "1 1 auto",
  },
  navLink: {
    display: "inline-flex",
    alignItems: "center",
    height: tokens.chromeControlHeight,
    padding: "0 10px",
    borderRadius: tokens.chromeControlRadius,
    backgroundColor: {
      default: tokens.transparent,
      ":hover": tokens.chromeHoverBg,
    },
    color: {
      default: tokens.chromeFgMuted,
      ":hover": tokens.chromeFg,
    },
    fontWeight: fontWeight.medium,
    textDecoration: "none",
  },
  navLinkCurrent: {
    color: tokens.chromeFg,
  },
});
