import { mountReviewCanvas } from "@canvas/desktop-entry";
import { reviewFetchUrl } from "@canvas/host/review-client";
import type {
  AskAgentStatusLike,
  ReviewApiRepository,
  ReviewApiSummary,
  ReviewCanvasContent,
  ReviewCanvasSettingsContent,
} from "@dev.fast/review-protocol";
import { ReviewApiClient } from "@dev.fast/review-protocol";
import { z } from "zod";

import { mountSetupLink, mountWebSetup } from "./setup-view";
import { type WebAppFrame, mountWebAppFrame } from "./web-app-frame";
import {
  type WebSettingsValues,
  createWebBridge,
  loadWebSettings,
  webNotify,
} from "./web-bridge";

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

/** The route that opened Settings, stashed in `history.state` by `navigate`. */
const settingsStateSchema = z.object({ from: z.string().optional() });

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

function renderTokenPrompt(
  container: HTMLElement,
  signIn?: { href: string; label: string },
): void {
  const page = document.createElement("main");
  const heading = document.createElement("h1");
  const text = document.createElement("p");
  const form = document.createElement("form");
  const input = document.createElement("input");
  const button = document.createElement("button");

  heading.textContent = "Whiteboard Reviews";
  text.textContent = signIn
    ? "Sign in to see this team's reviews. A personal API token from Settings also works."
    : "This canvas needs the token from your review link. Paste it below to continue.";
  input.type = "password";
  input.placeholder = signIn ? "Personal API token" : "Review token";
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

  if (signIn) {
    const link = document.createElement("a");

    link.href = `${signIn.href}?next=${encodeURIComponent(
      `${location.pathname}${location.search}`,
    )}`;
    link.textContent = signIn.label;
    link.style.cssText =
      "display:inline-block;padding:8px 16px;border-radius:6px;" +
      "background:#eef0f4;color:#0c0f15;font:inherit;font-weight:600;" +
      "text-decoration:none;text-align:center;";
    page.append(heading, text, link, form);
  } else {
    page.append(heading, text, form);
  }

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

  // The brand bar wraps every page the entry can show: canvas, setup, or the
  // token prompt. It exists before auth resolves, so it never knows secrets.
  const frame = mountWebAppFrame(container);

  // True once a hosted deployment answered /auth/session: the canvas enters
  // through GitHub sign-in instead of a pasted token.
  let remoteAuth = false;

  const request = async (url: string, init?: RequestInit) => {
    // Tokenless requests still carry the hosted deployment's session cookie;
    // a local server never sets one and treats them the same as before.
    const requestInit = token
      ? init
      : { ...init, credentials: "same-origin" as const };

    const response = options.request
      ? await options.request(url, requestInit)
      : await reviewFetchUrl({ serverUrl, token }, url, requestInit);

    // A signed-in session that lapses answers API calls with 401; send the
    // tab back through the deployment's sign-in instead of leaving errors.
    if (
      remoteAuth &&
      !token &&
      response.status === 401 &&
      url.includes("/reviews-api")
    ) {
      location.assign(
        `/auth/sign-in?next=${encodeURIComponent(
          `${location.pathname}${location.search}`,
        )}`,
      );
    }

    return response;
  };

  // The setup landing page is reachable before any token exists: it is what
  // teaches an agent how to connect, so it never hits the token prompt.
  if (location.pathname === "/setup") {
    frame.update({ context: "Setup" });
    const setup = mountWebSetup(frame.page, { serverUrl, token, request });

    return {
      dispose() {
        setup.dispose();
        frame.dispose();
      },
    };
  }

  if (token)
    return mountWebCanvas(frame.page, serverUrl, token, request, frame);

  let disposed = false;
  let mounted: WebAppHandle | undefined;

  const showPrompt = () => {
    if (!disposed) renderTokenPrompt(frame.page);
  };

  const showSignIn = (signIn?: string) => {
    if (disposed) return;

    // GitHub OAuth links straight at the provider; a proxy-only deployment
    // gets its instructions from the server's own sign-in page.
    renderTokenPrompt(
      frame.page,
      signIn
        ? { href: signIn, label: "Sign in with GitHub" }
        : { href: "/auth/sign-in", label: "Sign in" },
    );
  };

  const probe = async () => {
    // Hosted deployments answer /auth/session for any caller; a local server
    // returns 401 and the token prompt below handles it as before.
    const session = await request(`${serverUrl}/auth/session`)
      .then(async (response) => {
        if (!response.ok) return undefined;

        const body: unknown = await response.json().catch(() => ({}));

        // SAFETY: a 2xx session answer carries these fields when present;
        // missing keys read as unauthenticated below.
        return body as { authenticated?: boolean; signIn?: string };
      })
      .catch(() => undefined);

    if (session) remoteAuth = true;

    if (session?.authenticated === true) {
      mounted = mountWebCanvas(frame.page, serverUrl, token, request, frame);

      return;
    }

    if (session?.authenticated === false) {
      showSignIn(session.signIn);

      return;
    }

    const response = await request(`${serverUrl}/reviews-api/capabilities`);

    if (!response.ok || (await response.json()).localBrowserAuth !== true) {
      showPrompt();

      return;
    }

    if (!disposed)
      mounted = mountWebCanvas(frame.page, serverUrl, token, request, frame);
  };

  void probe().catch(() => showPrompt());

  return {
    dispose() {
      disposed = true;
      mounted?.dispose();
      frame.dispose();
    },
  };
}

function mountWebCanvas(
  container: HTMLElement,
  serverUrl: string,
  token: string,
  request: (url: string, init?: RequestInit) => Promise<Response>,
  frame: WebAppFrame,
): WebAppHandle {
  const client = new ReviewApiClient({ serverUrl, token }, request);
  const canvas = mountReviewCanvas(container, { kind: "loading" });
  const setupLink = mountSetupLink(container);

  let reviews: ReviewApiSummary[] = [];
  let repositories: ReviewApiRepository[] = [];
  let searchQuery = "";
  let catalogError: string | undefined;
  let hostedMode = false;
  let hostedModePromise: Promise<boolean> | undefined;
  let catalog: AbortController | undefined;
  let disposed = false;
  let webValues: WebSettingsValues | undefined;
  let settingsContent: ReviewCanvasSettingsContent | undefined;
  let settingsPromise: Promise<ReviewCanvasSettingsContent> | undefined;
  let activeBridge: ReturnType<typeof createWebBridge> | undefined;

  let activeReviewContent:
    | Extract<ReviewCanvasContent, { kind: "api" }>
    | undefined;

  const navigate = (path: string) => {
    if (path === `${location.pathname}${location.search}`) return;

    // Navigating to Settings remembers the sender so closing it goes back,
    // not home. Re-entering Settings keeps the sender it already has.
    const state =
      path === "/settings"
        ? location.pathname === "/settings"
          ? history.state
          : { from: `${location.pathname}${location.search}${location.hash}` }
        : null;

    history.pushState(state, "", path);
    route();
  };

  frame.update({ onNavigate: navigate });

  let settingsFrom: string | undefined;

  const closeSettings = () => navigate(settingsFrom ?? "/");

  const openReview = (reviewId: string) =>
    navigate(`/r/${encodeURIComponent(reviewId)}`);

  const bridgeOptions = {
    serverUrl,
    token,
    request,
    openReview,
    openSettings: () => navigate("/settings"),
  };

  const canvasTheme = (theme = webValues?.theme ?? "system") =>
    theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;

  const onSettingsChange = (next: WebSettingsValues) => {
    if (webValues) Object.assign(webValues, next);
    else webValues = { ...next };
    activeBridge?.setCurrentTheme?.(canvasTheme(next.theme));

    if (activeReviewContent) {
      activeReviewContent = {
        ...activeReviewContent,
        documentWidth: next.documentWidth,
        codeFontSize: next.codeFontSize,
        softwareMapEnabled: next.softwareMapEnabled,
        structuralDiffEnabled: next.structuralDiffEnabled,
      };
      canvas.update(activeReviewContent);
    } else if (location.pathname === "/settings" && settingsContent) {
      settingsContent = { ...settingsContent, ...next };
      canvas.update({
        kind: "settings",
        settings: settingsContent,
        theme: canvasTheme(next.theme),
        close: closeSettings,
      });
    } else if (location.pathname === "/" && settingsContent) {
      canvas.update(homeContent());
    }
  };

  const ensureSettings = () => {
    settingsPromise ??= loadWebSettings(bridgeOptions, onSettingsChange).then(
      (settings) => {
        settingsContent = settings;
        webValues = {
          theme: settings.theme,
          documentWidth: settings.documentWidth,
          codeFontSize: settings.codeFontSize,
          scratchpadEnabled: settings.scratchpadEnabled,
          softwareMapEnabled: settings.softwareMapEnabled,
          structuralDiffEnabled: settings.structuralDiffEnabled,
        };

        return settings;
      },
    );

    return settingsPromise;
  };

  const ensureHostedMode = () => {
    hostedModePromise ??= client
      .read<{ deployment?: { mode?: string } }>("/status")
      .then((status) => status.deployment?.mode === "remote")
      .catch(() => false)
      .then((isHosted) => {
        hostedMode = isHosted;

        return isHosted;
      });

    return hostedModePromise;
  };

  const homeContent = (): ReviewCanvasContent => ({
    kind: "home",
    hostedMode,
    reviews,
    repositories,
    searchQuery,
    setSearchQuery(query) {
      searchQuery = query;
    },
    catalogError,
    refreshCatalog() {
      void showHome();
    },
    askAgents: hostedMode
      ? undefined
      : async () => {
          const result = await client.read<{ agents: AskAgentStatusLike[] }>(
            "/ask/agents",
          );

          return result.agents;
        },
    editTags: async (reviewId, change) => {
      const result = await client.post<{ tags?: string[] }>("/commands", {
        operation: { type: "tags", reviewId, ...change },
      });

      return result.tags ?? [];
    },
    createSession: async ({ title, repositoryId, task }) => {
      const result = await client.post<{ review: ReviewApiSummary }>(
        "/commands",
        {
          operation: {
            type: "create",
            title,
            target: { kind: "worktree", repositoryId },
            open: false,
          },
        },
      );

      if (task?.prompt.trim()) {
        try {
          if (hostedMode) {
            await client.post("/asks", {
              reviewId: result.review.reviewId,
              prompt: task.prompt,
              purpose: "build",
            });
          } else {
            await client.post(
              `/${encodeURIComponent(result.review.reviewId)}/ask`,
              {
                agent: task.agent,
                question: { text: task.prompt },
                purpose: "build",
              },
            );
          }

          webNotify(
            "success",
            hostedMode
              ? "Task queued for a local connector"
              : `${task.agent} is building this session`,
          );
        } catch (error) {
          webNotify(
            "error",
            `Session created, but the agent task could not be started: ${error instanceof Error ? error.message : "Unknown error."}`,
          );
        }
      }

      return result.review;
    },
    theme: canvasTheme(),
    openReview,
    openTutorial() {
      webNotify("success", "The tutorial runs in the Whiteboard desktop app.");
    },
  });

  const colorScheme = matchMedia("(prefers-color-scheme: dark)");

  const updateSystemTheme = () => {
    if (webValues?.theme !== "system" || activeBridge) return;

    if (location.pathname === "/settings" && settingsContent) {
      canvas.update({
        kind: "settings",
        settings: settingsContent,
        theme: canvasTheme("system"),
        close: closeSettings,
      });
    } else if (location.pathname === "/") {
      canvas.update(homeContent());
    }
  };

  colorScheme.addEventListener("change", updateSystemTheme);

  async function showReview(reviewId: string) {
    catalog?.abort();
    await ensureSettings();

    if (disposed || location.pathname !== `/r/${encodeURIComponent(reviewId)}`)
      return;
    activeBridge = createWebBridge({
      ...bridgeOptions,
      reviewId,
      settings: webValues,
      openSettings: bridgeOptions.openSettings,
    });
    activeReviewContent = {
      kind: "api",
      reviewId,
      bridge: activeBridge,
      documentWidth: webValues?.documentWidth,
      codeFontSize: webValues?.codeFontSize,
      softwareMapEnabled: webValues?.softwareMapEnabled === true,
      structuralDiffEnabled: webValues?.structuralDiffEnabled === true,
      setTitle(title) {
        // A late snapshot must not retitle a page the reader already left.
        if (location.pathname !== `/r/${encodeURIComponent(reviewId)}`) return;
        document.title = title || "Whiteboard Review";
        frame.update({ context: title || "Session" });
      },
      setSourceView(_selection, view) {
        activeBridge?.setSourceView(view);
      },
    };
    canvas.update(activeReviewContent);
  }

  async function showHome() {
    activeReviewContent = undefined;
    activeBridge = undefined;
    catalog?.abort();
    catalog = new AbortController();
    const signal = catalog.signal;

    document.title = "Whiteboard Reviews";
    canvas.update({ kind: "loading" });

    try {
      const [nextReviews, nextRepositories] = await Promise.all([
        client.read<ReviewApiSummary[]>("", signal),
        client.read<ReviewApiRepository[]>("/repositories", signal),
        ensureHostedMode(),
        ensureSettings(),
      ]);

      reviews = nextReviews;
      repositories = nextRepositories;
      catalogError = undefined;
    } catch (error) {
      if (!signal.aborted && !disposed) {
        canvas.update({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not load the review catalog.",
          retry() {
            void showHome();
          },
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
        catalogError = undefined;

        if (!signal.aborted && !disposed) canvas.update(homeContent());
      },
      (cause) => {
        catalogError =
          cause instanceof Error
            ? cause.message
            : "The live catalog connection was interrupted.";

        if (!signal.aborted && !disposed) canvas.update(homeContent());
      },
    );
  }

  function route() {
    setupLink.setVisible(location.pathname === "/");

    if (location.pathname === "/settings") {
      activeReviewContent = undefined;
      activeBridge = undefined;
      catalog?.abort();
      const state = settingsStateSchema.safeParse(history.state);
      settingsFrom = state.success ? state.data.from : undefined;
      frame.update({ context: "Settings" });
      document.title = "Settings - Whiteboard";
      void ensureSettings()
        .then((settings) => {
          if (!disposed && location.pathname === "/settings") {
            canvas.update({
              kind: "settings",
              settings,
              theme: canvasTheme(settings.theme),
              close: closeSettings,
            });
          }
        })
        .catch((error) =>
          canvas.update({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          }),
        );

      return;
    }

    const reviewId = routeReviewId(location.pathname);

    if (reviewId) {
      // Seed the crumb from the catalog; the snapshot's setTitle refines it.
      frame.update({
        context:
          reviews.find((review) => review.reviewId === reviewId)?.title ?? null,
      });
      showReview(reviewId);
    } else {
      frame.update({ context: null });
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
      colorScheme.removeEventListener("change", updateSystemTheme);
      setupLink.dispose();
      canvas.dispose();
      frame.dispose();
    },
  };
}
