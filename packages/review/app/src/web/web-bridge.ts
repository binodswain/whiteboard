import { reviewFetchUrl } from "@canvas/host/review-client";
import {
  type JsonValue,
  REVIEW_DISCORD_URL,
  type ReviewAccessTokens,
  type ReviewCanvasBridge,
  ReviewDiffFileSchema,
  type ReviewDiffFileWire,
  type ReviewDiffLayout,
  type ReviewRuntimeConfig,
  type ReviewSourceView,
  type ReviewStructuralDiffEvent,
  type ReviewSurfaceEvent,
  type ReviewTheme,
  type ReviewVerbRequest,
  type ReviewVerbResponse,
  decodeReviewStructuralDiffEvent,
  parseReviewDiffrConfig,
} from "@dev.fast/review-protocol";
import type { ReviewCanvasSettingsContent } from "@dev.fast/review-protocol";
import wasmAssetUrl from "@mr_mint/elkjs-libavoid/dist/libavoid.wasm?url";
import { z } from "zod";

import { type WebDiffViewSource, createWebDiffView } from "./web-diff-view";

const BROWSER_ONLY_MESSAGE =
  "This action opens an editor, which is unavailable in the browser review canvas.";

const DIFF_LAYOUT_KEY = "review-diff-layout";

const webSettingsSchema = z.object({
  theme: z.enum(["system", "light", "dark"]),
  documentWidth: z.enum(["standard", "wide", "full"]),
  codeFontSize: z.number().int().min(8).max(32),
  scratchpadEnabled: z.boolean(),
  softwareMapEnabled: z.boolean(),
  structuralDiffEnabled: z.boolean(),
});

export type WebSettingsValues = z.infer<typeof webSettingsSchema>;

const authSessionSchema = z.object({
  authenticated: z.boolean(),
  user: z.object({ via: z.string().optional() }).optional(),
});

const accessTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});

/** Personal API tokens exist on hosted deployments only; a session answer
 * says whether this viewer manages them. Token-authenticated callers cannot
 * mint further tokens. */
function accessTokens(
  request: (url: string, init?: RequestInit) => Promise<Response>,
  serverUrl: string,
  session: { authenticated: boolean; user?: { via?: string } },
): ReviewAccessTokens | undefined {
  if (!session.authenticated || session.user?.via === "api-token")
    return undefined;

  const url = `${serverUrl}/auth/tokens`;

  return {
    async list() {
      const response = await request(url);

      if (!response.ok)
        throw new Error(`Could not list API tokens (${response.status}).`);

      return z
        .object({ tokens: z.array(accessTokenSchema) })
        .parse(await response.json()).tokens;
    },
    async create(name) {
      const response = await request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (!response.ok)
        throw new Error(`Could not create an API token (${response.status}).`);

      return accessTokenSchema
        .extend({ token: z.string() })
        .parse(await response.json());
    },
    async revoke(id) {
      const response = await request(`${url}/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });

      if (!response.ok)
        throw new Error(`Could not revoke the API token (${response.status}).`);
    },
  };
}

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
  settings?: WebSettingsValues;
  openSettings?: () => void;
}

/** The web bridge exposes one extra hook the desktop doesn't need: the
 * canvas reports the displayed source version through `setSourceView`. */
export interface WebCanvasBridge extends ReviewCanvasBridge {
  setSourceView(view: ReviewSourceView): void;
}

export async function loadWebSettings(
  options: Pick<WebBridgeOptions, "serverUrl" | "token" | "request">,
  onChange?: (settings: WebSettingsValues) => void,
): Promise<ReviewCanvasSettingsContent> {
  const config = {
    serverUrl: options.serverUrl ?? location.origin,
    token: options.token ?? "",
  };

  const request =
    options.request ??
    ((url: string, init?: RequestInit) => reviewFetchUrl(config, url, init));

  const url = `${config.serverUrl}/reviews-api/settings`;

  // Hosted deployments sign the viewer in with a cookie; the endpoint only
  // exists there, so a missing or unauthenticated answer means no tokens.
  const session = await request(`${config.serverUrl}/auth/session`)
    .then(async (response) =>
      response.ok
        ? authSessionSchema.parse(await response.json())
        : { authenticated: false },
    )
    .catch(() => ({ authenticated: false }));

  const read = async () => {
    const response = await request(url);

    if (!response.ok)
      throw new Error(`Could not read settings (${response.status}).`);

    return webSettingsSchema.parse(await response.json());
  };

  let values = await read();

  const update = async (patch: Partial<WebSettingsValues>) => {
    const response = await request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });

    if (!response.ok)
      throw new Error(`Could not save settings (${response.status}).`);
    values = webSettingsSchema.parse(await response.json());
    onChange?.(values);

    return values;
  };

  // The diffr config endpoints answer the same JSON envelope as the API:
  // `{ error }` on failure, the payload itself otherwise.
  const readJson = async <T = unknown>(path: string): Promise<T> => {
    const response = await request(`${config.serverUrl}${path}`);

    if (!response.ok)
      throw new Error(
        (await response.json().catch(() => ({}))).error ??
          `diffr configuration request failed (${response.status}).`,
      );

    return response.json();
  };

  const writeJson = async <T = unknown>(
    path: string,
    method: "PUT" | "POST",
    body: JsonValue,
  ): Promise<T> => {
    const response = await request(`${config.serverUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok)
      throw new Error(
        (await response.json().catch(() => ({}))).error ??
          `diffr configuration request failed (${response.status}).`,
      );

    return response.json();
  };

  const unavailable = async <T>(value: T) => value;

  return {
    telemetryEnabled: false,
    setTelemetryEnabled: (enabled) => unavailable(enabled),
    theme: values.theme,
    setTheme: async (theme) => (await update({ theme })).theme,
    keymap: "none",
    setKeymap: (choice) => unavailable(choice),
    ctrlTab: "recent",
    setCtrlTab: (choice) => unavailable(choice),
    documentWidth: values.documentWidth,
    setDocumentWidth: async (documentWidth) =>
      (await update({ documentWidth })).documentWidth,
    codeFontSize: values.codeFontSize,
    setCodeFontSize: async (codeFontSize) =>
      (await update({ codeFontSize })).codeFontSize,
    readyNotification: "off",
    setReadyNotification: (choice) => unavailable(choice),
    softwareMapEnabled: values.softwareMapEnabled,
    setSoftwareMapEnabled: async (softwareMapEnabled) =>
      (await update({ softwareMapEnabled })).softwareMapEnabled,
    structuralDiffEnabled: values.structuralDiffEnabled,
    setStructuralDiffEnabled: async (structuralDiffEnabled) =>
      (await update({ structuralDiffEnabled })).structuralDiffEnabled,
    scratchpadEnabled: values.scratchpadEnabled,
    setScratchpadEnabled: async (scratchpadEnabled) =>
      (await update({ scratchpadEnabled })).scratchpadEnabled,
    diffrConfig: {
      read: async () => parseReviewDiffrConfig(await readJson("/diffr-config")),
      set: async (key, value) =>
        parseReviewDiffrConfig(
          await writeJson("/diffr-config", "PUT", { key, value }),
        ),
      saveSummarizer: async (input) =>
        parseReviewDiffrConfig(
          await writeJson("/diffr-config/summarizer", "PUT", input),
        ),
      testSummarizer: async (input) =>
        (
          await writeJson<{ summary: string }>(
            "/diffr-config/summarizer/test",
            "POST",
            input,
          )
        ).summary,
    },
    reloadWindow: async () => {
      location.reload();
    },
    manageExtensions: () => {},
    importVsCodeSettings: () => {},
    web: true,
    accessTokens: accessTokens(request, config.serverUrl, session),
  } satisfies ReviewCanvasSettingsContent;
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
): WebCanvasBridge {
  const media =
    typeof matchMedia === "undefined"
      ? null
      : matchMedia("(prefers-color-scheme: dark)");

  const resolvedTheme = (choice?: WebSettingsValues["theme"]): ReviewTheme =>
    choice && choice !== "system" ? choice : media?.matches ? "dark" : "light";

  let currentTheme = resolvedTheme(options.settings?.theme);

  const config: ReviewRuntimeConfig = {
    serverUrl: options.serverUrl ?? location.origin,
    reviewId: options.reviewId ?? "",
    token: options.token ?? "",
    wasmUrl: new URL(wasmAssetUrl, location.href).href,
    appVersion: "web",
    theme: currentTheme,
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

  // SAFETY: version starts unset (0); the canvas installs a real
  // ReviewSourceView through setSourceView before any diff request.
  const sourceView = {
    current: {
      reviewId: options.reviewId ?? "",
      version: 0,
    } as ReviewSourceView,
  };

  const setCurrentTheme = (theme: ReviewTheme) => {
    currentTheme = theme;
    config.theme = theme;
    listeners.forEach((listener) => listener({ event: "themeChanged", theme }));
    themeListeners.forEach((listener) => listener(theme));
  };

  const themeListeners = new Set<(theme: ReviewTheme) => void>();

  media?.addEventListener("change", () => {
    if (!options.settings || options.settings.theme === "system")
      setCurrentTheme(resolvedTheme("system"));
  });

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

        return {
          ok: true,
          result: {
            softwareMapEnabled: options.settings?.softwareMapEnabled === true,
          },
        };

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

  const request =
    options.request ?? ((url, init) => reviewFetchUrl(config, url, init));

  return {
    config,
    request,

    subscribe(listener) {
      listeners.add(listener);

      return { dispose: () => listeners.delete(listener) };
    },

    post,
    currentTheme: () => currentTheme,
    setCurrentTheme,
    openSettings: options.openSettings,

    onDidChangeTheme(listener) {
      themeListeners.add(listener);

      return { dispose: () => themeListeners.delete(listener) };
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

    diffView: createWebDiffView({
      source: {
        async files(scope, patch) {
          const view = sourceView.current;
          const query = new URLSearchParams();

          if (view.version) query.set("version", String(view.version));

          if (scope?.commit) query.set("commit", scope.commit);

          if (patch) query.set("patch", "true");

          const response = await request(
            `${config.serverUrl}/reviews-api/${encodeURIComponent(
              view.reviewId,
            )}/diff?${query}`,
          );

          if (!response.ok)
            throw new Error(
              (await response.json().catch(() => ({}))).error ??
                `Could not load the diff (${response.status}).`,
            );

          return z.array(ReviewDiffFileSchema).parse(await response.json());
        },

        async *structural(query, signal) {
          const view = sourceView.current;
          const params = new URLSearchParams();

          if (query.version) params.set("version", String(query.version));

          if (query.commit) params.set("commit", query.commit);

          const response = await request(
            `${config.serverUrl}/reviews-api/${encodeURIComponent(
              view.reviewId,
            )}/structural-diff?${params}`,
            { signal },
          );

          if (!response.ok)
            throw new Error(
              (await response.json().catch(() => ({}))).error ??
                "Structural diff request failed.",
            );

          if (!response.body) throw new Error("The diff stream did not open.");

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          try {
            for (;;) {
              const chunk = await reader.read();

              buffer += decoder.decode(chunk.value, { stream: !chunk.done });

              const lines = buffer.split("\n");

              buffer = lines.pop()!;

              if (chunk.done && buffer.trim()) {
                lines.push(buffer);
                buffer = "";
              }

              for (const line of lines) {
                if (!line.trim()) continue;

                const event: ReviewStructuralDiffEvent =
                  decodeReviewStructuralDiffEvent(line);

                if (event.type === "error") throw new Error(event.message);

                yield event;
              }

              if (chunk.done) break;
            }
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        },
      } satisfies WebDiffViewSource,
      structural: () => options.settings?.structuralDiffEnabled === true,
      layout: () => diffLayout,
      onDidChangeLayout: (listener) => {
        diffLayoutListeners.add(listener);

        return { dispose: () => diffLayoutListeners.delete(listener) };
      },
      codeFontSize: () => options.settings?.codeFontSize,
      sourceVersion: () => sourceView.current.version || undefined,
    }),

    notify({ kind, text }) {
      webNotify(kind, text);
    },

    setSourceView(view) {
      sourceView.current = view;
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
