import { reviewFetchUrl } from "@canvas/host/review-client";
import {
  REVIEW_DISCORD_URL,
  type ReviewCanvasBridge,
  type ReviewDiffLayout,
  type ReviewRuntimeConfig,
  type ReviewSurfaceEvent,
  type ReviewTheme,
  type ReviewVerbRequest,
  type ReviewVerbResponse,
} from "@dev.fast/review-protocol";
import wasmAssetUrl from "@mr_mint/elkjs-libavoid/dist/libavoid.wasm?url";

const BROWSER_ONLY_MESSAGE =
  "This action opens an editor, which is unavailable in the browser review canvas.";

const DIFF_LAYOUT_KEY = "review-diff-layout";

export interface WebBridgeOptions {
  /** The review this bridge serves; empty while the canvas shows Home. */
  reviewId?: string;
  /** The review server's origin; the page's own origin by default. */
  serverUrl?: string;
  /** The server token, already resolved from the fragment or sessionStorage. */
  token?: string;
  /**
   * Navigates to another review without a reload. Falls back to a full page
   * navigation when the entry did not install a router.
   */
  openReview?: (reviewId: string) => void;
  /** Test seam: the host request the canvas's API client shares. */
  request?: (url: string, init?: RequestInit) => Promise<Response>;
}

function reviewPageUrl(reviewId: string): string {
  return `${location.origin}/r/${encodeURIComponent(reviewId)}`;
}

/** The bridge's `notify`, also usable standalone (e.g. the Home tutorial cue). */
export function webNotify(kind: "success" | "error", text: string): void {
  const toast = document.createElement("div");

  toast.textContent = text;
  toast.setAttribute("role", kind === "error" ? "alert" : "status");
  toast.style.cssText =
    "position:fixed;inset-inline-end:16px;inset-block-end:16px;" +
    "max-width:min(360px,80vw);padding:10px 14px;border-radius:8px;" +
    "background:var(--tray,#12161e);color:var(--ink,#eef0f4);" +
    "border:1px solid var(--rule,#262c37);z-index:2147483000;" +
    "font:13px/1.4 inherit;box-shadow:0 8px 24px rgb(0 0 0 / 40%);";
  document.body.append(toast);
  setTimeout(() => toast.remove(), 4000);
}

/**
 * An embedded editor's stand-in on the web: a quiet notice inside the slot the
 * host reserved, with a handle that answers every query neutrally.
 */
function mountUnavailableNotice(container: HTMLElement, text: string): number {
  const notice = container.ownerDocument.createElement("div");

  notice.textContent = text;
  notice.style.cssText =
    "padding:16px;border:1px dashed var(--rule,#ccc);border-radius:8px;" +
    "color:var(--ink-muted,#888);font:13px/1.5 inherit;";
  container.append(notice);

  return notice.offsetHeight || 56;
}

/**
 * The bridge the canvas talks to in a plain browser tab: same contract as the
 * workbench bridge, but API traffic goes through fetch and every host feature
 * that needs an editor degrades to a readable placeholder.
 */
export function createWebBridge(
  options: WebBridgeOptions = {},
): ReviewCanvasBridge {
  const media =
    typeof matchMedia === "undefined"
      ? null
      : matchMedia("(prefers-color-scheme: dark)");

  const theme = (): ReviewTheme => (media?.matches ? "dark" : "light");

  const config: ReviewRuntimeConfig = {
    serverUrl: options.serverUrl ?? location.origin,
    reviewId: options.reviewId ?? "",
    token: options.token ?? "",
    wasmUrl: new URL(wasmAssetUrl, location.href).href,
    appVersion: "web",
    theme: theme(),
    host: "desktop",
    surface: "web",
  };

  const listeners = new Set<(event: ReviewSurfaceEvent) => void>();

  const emit = (event: ReviewSurfaceEvent) => {
    for (const listener of listeners) listener(event);
  };

  const openReview = (reviewId: string) => {
    if (options.openReview) {
      options.openReview(reviewId);
    } else {
      location.assign(reviewPageUrl(reviewId));
    }
  };

  let diffLayout: ReviewDiffLayout =
    (globalThis.localStorage?.getItem(DIFF_LAYOUT_KEY) ?? "split") === "unified"
      ? "unified"
      : "split";

  const diffLayoutListeners = new Set<(layout: ReviewDiffLayout) => void>();

  async function post(request: ReviewVerbRequest): Promise<ReviewVerbResponse> {
    switch (request.name) {
      case "openReview":
        if (request.args.active) {
          openReview(request.args.reviewUuid);
        } else {
          window.open(
            reviewPageUrl(request.args.reviewUuid),
            "_blank",
            "noopener",
          );
        }

        return { ok: true };

      case "openApiReview":
        openReview(request.args.reviewId);

        return { ok: true, result: { softwareMapEnabled: false } };

      case "joinDiscord":
        window.open(REVIEW_DISCORD_URL, "_blank", "noopener");

        return { ok: true };

      case "showReviewView":
        emit({ event: "showReviewView", view: request.args.view });

        return { ok: true };

      case "focusWindow":
        window.focus();

        return { ok: true };

      // No window contents to capture; callers proceed without a screenshot.
      case "captureScreenshot":
        return { ok: true };

      default:
        return { ok: false, error: BROWSER_ONLY_MESSAGE };
    }
  }

  return {
    config,
    request:
      options.request ?? ((url, init) => reviewFetchUrl(config, url, init)),

    subscribe(listener) {
      listeners.add(listener);

      return { dispose: () => listeners.delete(listener) };
    },

    post,
    currentTheme: theme,

    onDidChangeTheme(listener) {
      if (!media) return { dispose() {} };

      const changed = () => listener(theme());

      media.addEventListener("change", changed);

      return {
        dispose: () => media.removeEventListener("change", changed),
      };
    },

    currentDiffLayout: () => diffLayout,

    async setDiffLayout(layout) {
      diffLayout = layout;
      globalThis.localStorage?.setItem(DIFF_LAYOUT_KEY, layout);
      diffLayoutListeners.forEach((listener) => listener(layout));
    },

    onDidChangeDiffLayout(listener) {
      diffLayoutListeners.add(listener);

      return { dispose: () => diffLayoutListeners.delete(listener) };
    },

    inlineEditors: {
      create(spec) {
        const height = mountUnavailableNotice(
          spec.container,
          "Open this review in the desktop app to read the source.",
        );

        const noOp = { dispose() {} };

        return {
          height,
          dispose() {},
          setActive() {},
          setCollapsed() {},
          onDidChangeHeight: () => noOp,
          onDidError: () => noOp,
          async setFindQuery() {
            return { matchCount: 0 };
          },
          revealFindMatch() {},
          clearActiveFindMatch() {},
          clearFind() {},
        };
      },

      async find() {
        return { matchCount: 0 };
      },
    },

    diffView: {
      create(spec) {
        mountUnavailableNotice(
          spec.container,
          "Open this review in the desktop app to browse its diff.",
        );
        const noOp = { dispose() {} };

        return {
          dispose() {},
          focus() {},
          onDidError: () => noOp,
        };
      },

      async files() {
        return [];
      },
    },

    notify({ kind, text }) {
      webNotify(kind, text);
    },

    setupTooltip(target, text, options) {
      const detail = options?.detail;
      const title = detail ? `${text}\n${detail}` : text;

      target.title = title;

      return {
        dispose: () => target.removeAttribute("title"),
      };
    },

    ready() {},

    reportDiagnostic(diagnostic) {
      console.error("Review canvas diagnostic", diagnostic);
    },
  };
}
