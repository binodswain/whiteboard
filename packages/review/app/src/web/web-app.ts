import { mountReviewCanvas } from "@canvas/desktop-entry";
import { reviewFetchUrl } from "@canvas/host/review-client";
import type {
  ReviewApiSummary,
  ReviewCanvasContent,
} from "@dev.fast/review-protocol";
import { ReviewApiClient } from "@dev.fast/review-protocol";

import { createWebBridge, webNotify } from "./web-bridge";

const TOKEN_KEY = "review-token";

export interface WebAppOptions {
  /** Defaults to the page origin: the web bundle is served by the review server. */
  serverUrl?: string;
  /** Overrides the fragment/sessionStorage token; tests inject one here. */
  token?: string;
  /** Test seam: the request function the API client and bridges share. */
  request?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface WebAppHandle {
  dispose(): void;
}

/** `/r/:id` names a review; everything else is Home. */
function routeReviewId(pathname: string): string | null {
  const match = /^\/r\/([^/]+)\/?$/.exec(pathname);

  return match ? decodeURIComponent(match[1]) : null;
}

/** Server tokens are base64url/hex secrets; the charset keeps `#anchor` links intact. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{16,}$/;

/**
 * The server links reviews as `/r/:id#token=...` or `#<token>`. Capture the
 * token, keep it in sessionStorage so refreshes and client-side navigation
 * stay signed in, then strip it from the address bar.
 */
function captureFragmentToken(): string {
  const hash = location.hash.slice(1);

  if (!hash) return "";

  const value = decodeURIComponent(
    hash.startsWith("token=") ? hash.slice("token=".length) : hash,
  );

  // A fragment that does not carry a token is an in-document anchor: leave it.
  if (!hash.startsWith("token=") && !TOKEN_FORMAT.test(value)) return "";

  history.replaceState(null, "", `${location.pathname}${location.search}`);
  sessionStorage.setItem(TOKEN_KEY, value);

  return value;
}

function renderTokenPrompt(container: HTMLElement): void {
  const page = document.createElement("main");
  const heading = document.createElement("h1");
  const text = document.createElement("p");
  const form = document.createElement("form");
  const input = document.createElement("input");
  const button = document.createElement("button");

  heading.textContent = "Whiteboard Reviews";
  text.textContent =
    "This canvas needs the token from your review link. Paste it below to continue.";
  input.type = "password";
  input.placeholder = "Review token";
  input.autocomplete = "off";
  input.required = true;
  button.type = "submit";
  button.textContent = "Continue";
  page.style.cssText =
    "min-height:100%;display:grid;place-content:center;gap:12px;" +
    "padding:24px;font:14px/1.5 system-ui,sans-serif;" +
    "background:#0c0f15;color:#eef0f4;";
  form.style.cssText = "display:flex;gap:8px;";
  input.style.cssText =
    "padding:8px 12px;border-radius:6px;border:1px solid #39404d;" +
    "background:#1a1f29;color:inherit;font:inherit;min-width:240px;";
  button.style.cssText =
    "padding:8px 16px;border-radius:6px;border:0;background:#5b7cff;" +
    "color:#fff;font:inherit;cursor:pointer;";

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const token = input.value.trim();

    if (!token) return;

    sessionStorage.setItem(TOKEN_KEY, token);
    location.reload();
  });

  form.append(input, button);
  page.append(heading, text, form);
  container.append(page);
}

/**
 * Mounts the canvas and a tiny router: Home at `/`, a review at `/r/:id`. The
 * catalog is followed while Home is visible so reviews created after page load
 * appear without a reload.
 */
export function startWebCanvas(
  container: HTMLElement,
  options: WebAppOptions = {},
): WebAppHandle {
  const fragmentToken = captureFragmentToken();

  const token =
    options.token || fragmentToken || sessionStorage.getItem(TOKEN_KEY) || "";

  const serverUrl = options.serverUrl ?? location.origin;

  const request = (url: string, init?: RequestInit) => {
    const requestInit = token
      ? init
      : { ...init, credentials: "omit" as const };

    return options.request
      ? options.request(url, requestInit)
      : reviewFetchUrl({ serverUrl, token }, url, requestInit);
  };

  if (token) return mountWebCanvas(container, serverUrl, token, request);

  let disposed = false;
  let mounted: WebAppHandle | undefined;

  const showPrompt = () => {
    if (!disposed) renderTokenPrompt(container);
  };

  void request(`${serverUrl}/reviews-api/capabilities`)
    .then(async (response) => {
      if (!response.ok || (await response.json()).localBrowserAuth !== true) {
        showPrompt();

        return;
      }

      if (!disposed)
        mounted = mountWebCanvas(container, serverUrl, token, request);
    })
    .catch(showPrompt);

  return {
    dispose() {
      disposed = true;
      mounted?.dispose();

      if (!mounted) container.replaceChildren();
    },
  };
}

function mountWebCanvas(
  container: HTMLElement,
  serverUrl: string,
  token: string,
  request: (url: string, init?: RequestInit) => Promise<Response>,
): WebAppHandle {
  const client = new ReviewApiClient({ serverUrl, token }, request);
  const canvas = mountReviewCanvas(container, { kind: "loading" });

  let reviews: ReviewApiSummary[] = [];
  let catalog: AbortController | undefined;
  let disposed = false;

  const navigate = (path: string) => {
    history.pushState(null, "", path);
    route();
  };

  const openReview = (reviewId: string) =>
    navigate(`/r/${encodeURIComponent(reviewId)}`);

  const bridgeOptions = {
    serverUrl,
    token,
    request,
    openReview,
  };

  const homeContent = (): ReviewCanvasContent => ({
    kind: "home",
    reviews,
    openReview,
    openTutorial() {
      webNotify("success", "The tutorial runs in the Whiteboard desktop app.");
    },
  });

  function showReview(reviewId: string) {
    catalog?.abort();
    canvas.update({
      kind: "api",
      reviewId,
      bridge: createWebBridge({ ...bridgeOptions, reviewId }),
      setTitle(title) {
        document.title = title || "Whiteboard Review";
      },
    });
  }

  async function showHome() {
    catalog?.abort();
    catalog = new AbortController();
    const signal = catalog.signal;

    document.title = "Whiteboard Reviews";

    try {
      reviews = await client.read<ReviewApiSummary[]>("", signal);
    } catch (error) {
      if (!signal.aborted && !disposed) {
        canvas.update({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not load the review catalog.",
        });
      }

      return;
    }

    if (signal.aborted || disposed) return;

    canvas.update(homeContent());

    void client.follow<ReviewApiSummary[]>(
      null,
      signal,
      (catalogUpdate) => {
        reviews = catalogUpdate;

        if (!signal.aborted && !disposed) canvas.update(homeContent());
      },
      (cause) => console.error("Review catalog connection lost.", cause),
    );
  }

  function route() {
    const reviewId = routeReviewId(location.pathname);

    if (reviewId) {
      showReview(reviewId);
    } else {
      void showHome();
    }
  }

  window.addEventListener("popstate", route);
  route();

  return {
    dispose() {
      disposed = true;
      catalog?.abort();
      window.removeEventListener("popstate", route);
      canvas.dispose();
    },
  };
}
