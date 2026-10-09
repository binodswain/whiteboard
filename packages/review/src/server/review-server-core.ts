import path from "node:path";

import type { JsonObject } from "@dev.fast/json";
import type {
  ReviewServerHealth,
  ReviewServerHealthWithToken,
} from "@dev.fast/review-protocol";
import { traceMachineEnabled } from "@dev.fast/trace-core";
import { serveStatic } from "@hono/node-server/serve-static";
import { detectAskAgents, launchAskAgent } from "@review/ask/agents.js";
import { AskThreads, type AskTools } from "@review/ask/threads.js";
import {
  readBuildCommit,
  readReviewPackageVersion,
} from "@review/package-paths.js";
import { ReviewInputError } from "@review/review-api/document.js";
import {
  type AuthoringCapabilities,
  type ReviewApiHooks,
  createReviewApi,
  isLocalAuthRequest,
} from "@review/review-api/http.js";
import type { LocalReviewData } from "@review/review-api/local-data.js";
import type { ReviewStore } from "@review/review-api/store.js";
import { mountSharingPublisher } from "@review/sharing/host.js";
import type { SharedReviewStore } from "@review/sharing/import.js";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import {
  loadDeploymentConfig,
  publicDeploymentConfig,
} from "./deployment-config.js";
import type { ReviewDesktopVerbRelay } from "./global-verb-relay";
import {
  type ReviewHonoEnv,
  applyCorsHeaders,
  corsPreflightResponse,
  isAuthorizedRequest,
  jsonResponse,
  readBoundedRequestJson,
} from "./hono-http";
import { HttpJsonError, ReviewServerError } from "./http-json";
import { createSetupInfoHandler } from "./setup-info.js";
import type { WebSettings } from "./web-settings.js";

const version = readReviewPackageVersion(import.meta.url);

const commit = readBuildCommit(import.meta.url);

/**
 * What every review server shares: CORS, an open /health, token auth, and
 * the /control relay a Desktop attaches to, with errors answered as JSON.
 * Callers add their routes after.
 */
export function createReviewServerApp(input: {
  token: string;
  instanceId: string;
  /** The review store's `serverId()`; a promise settles by the first /health. */
  serverId: string | Promise<string>;
  relay: ReviewDesktopVerbRelay;
  localBrowserAuth?: boolean;
  localBrowserPort?: () => number | undefined;
  deployment: ReturnType<typeof publicDeploymentConfig>;
}): Hono<ReviewHonoEnv> {
  const app = new Hono<ReviewHonoEnv>();
  app.use("*", async (context, next) => {
    await next();
    applyCorsHeaders(context.req.raw, context.res);
  });
  // Open to any caller, but the stable ids only to one holding the token.
  app.get("/health", async (context) => {
    const health: ReviewServerHealth & {
      deployment: ReturnType<typeof publicDeploymentConfig>;
    } = {
      ok: true,
      instanceId: input.instanceId,
      desktopAttached: input.relay.attached,
      version,
      deployment: input.deployment,
    };

    return serverJson(
      200,
      isAuthorizedRequest(context.req.raw, input.token) ||
        (input.localBrowserAuth &&
          isLocalAuthRequest(context.req.raw, input.localBrowserPort?.()))
        ? ({
            ...health,
            serverId: await input.serverId,
            serverPid: process.pid,
            commit,
          } satisfies ReviewServerHealthWithToken)
        : health,
    );
  });

  // Open like /health — it is how a host-side agent learns to connect — but
  // the token stays behind the same checks that guard it elsewhere.
  const setupInfo = createSetupInfoHandler({
    token: input.token,
    localBrowserAuth: input.localBrowserAuth,
    localBrowserPort: input.localBrowserPort,
    deployment: input.deployment,
  });

  app.get("/setup-info", (context) => setupInfo(context.req.raw));
  app.use("*", async (context, next) => {
    if (isAuthorizedRequest(context.req.raw, input.token)) return next();

    const path = new URL(context.req.url).pathname;

    const reviewApiPath =
      path === "/reviews-api" || path.startsWith("/reviews-api/");

    const localAuthPath =
      reviewApiPath ||
      path === "/mcp" ||
      path === "/control" ||
      path === "/control/result";

    if (
      input.localBrowserAuth &&
      localAuthPath &&
      isLocalAuthRequest(context.req.raw, input.localBrowserPort?.())
    )
      return next();

    if (input.localBrowserAuth && localAuthPath)
      return serverJson(403, {
        ok: false,
        error: "Local auth request not allowed",
      });

    if (context.req.method === "OPTIONS") return next();

    return serverJson(401, { ok: false, error: "Unauthorized" });
  });
  app.options("*", (context) => corsPreflightResponse(context.req.raw));
  app.get("/control", (context) => openControlEvents(context, input.relay));
  app.post("/control/result", async (context) => {
    const accepted = input.relay.acceptResult(
      await readBoundedRequestJson(context.req.raw),
    );

    return serverJson(accepted ? 200 : 404, { ok: accepted });
  });
  app.notFound(() => serverJson(404, { ok: false, error: "Not found." }));
  app.onError((error) => {
    const serverError = error instanceof ReviewServerError ? error : undefined;

    const message = toError(error).message;

    return serverJson(
      serverError?.statusCode ?? httpJsonStatus(error),
      serverError?.code
        ? { ok: false, code: serverError.code, error: message }
        : { ok: false, error: message },
    );
  });

  return app;
}

export interface WhiteboardCoreInput {
  profile: {
    store: ReviewStore;
    data: LocalReviewData;
    shared?: SharedReviewStore;
  };
  relay: ReviewDesktopVerbRelay;
  token: string;
  instanceId: string;
  localBrowserAuth?: boolean;
  localBrowserPort?: () => number | undefined;
  softwareMapEnabled?: boolean;
  scratchpad: () => boolean;
  status: () => JsonObject;
  hooks?: ReviewApiHooks;
  ask?: { tools: AskTools };
  webSettings?: {
    read(): Promise<WebSettings>;
    update(patch: Partial<WebSettings>): Promise<WebSettings>;
  };
  headlessOpenUrl?: (reviewId: string) => string;
}

export function createWhiteboardCore(input: WhiteboardCoreInput) {
  const { store, data, shared } = input.profile;
  const deployment = publicDeploymentConfig(loadDeploymentConfig());

  const app = createReviewServerApp({
    token: input.token,
    instanceId: input.instanceId,
    serverId: store.serverId(),
    relay: input.relay,
    localBrowserAuth: input.localBrowserAuth,
    localBrowserPort: input.localBrowserPort,
    deployment,
  });

  const callbacks = relayReviewCallbacks(input.relay, input.softwareMapEnabled);

  const askThreads =
    input.ask && new AskThreads(launchAskAgent, input.ask.tools);

  const api = createReviewApi(
    store,
    data,
    callbacks.open,
    shared,
    callbacks.capabilities,
    input.scratchpad,
    () => traceMachineEnabled(),
    () => ({ ...input.status(), deployment }),
    input.hooks,
    askThreads && { threads: askThreads, agents: () => detectAskAgents() },
    input.localBrowserAuth,
    input.webSettings,
    input.headlessOpenUrl,
  );

  // A shared store mounts the publisher with the rest of sharing.
  if (!shared) mountSharingPublisher(api, store, data);

  return { app, api, close: () => askThreads?.closeAll() };
}

// The canvas runs its own scripts, its styles, its fonts and the libavoid
// wasm, all from this origin. libavoid's embind glue builds invokers with
// `new Function`, so 'unsafe-eval' (which also covers WebAssembly) is the
// smallest script-src that runs it.
const WEB_CANVAS_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Serves the built web canvas from the same origin as the API: an outer,
 * unauthenticated app whose static routes answer before the core app's
 * `use("*")` token auth is reached. The first page load cannot carry the
 * token — it lives in the URL fragment, which never reaches the server — and
 * the files hold no data, so they are public. `/` and `/r/*` fall back to
 * `index.html` for the SPA's own router; anything else is left for the core
 * app, which keeps answering 401 or its JSON 404.
 */
export function serveWebCanvas(
  app: Hono<ReviewHonoEnv>,
  root: string,
): Hono<ReviewHonoEnv> {
  const indexPath = path.join(root, "index.html");
  const assetsDir = path.join(root, `assets${path.sep}`);

  const outer = new Hono<ReviewHonoEnv>();

  const headers = (file: string, context: Context<ReviewHonoEnv>) => {
    context.header(
      "cache-control",
      file === indexPath
        ? "no-store"
        : file.startsWith(assetsDir)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
    );
    context.header("content-security-policy", WEB_CANVAS_CSP);
  };

  const files = serveStatic<ReviewHonoEnv>({ root, onFound: headers });
  outer.use("*", (context, next) =>
    context.req.method === "GET" || context.req.method === "HEAD"
      ? files(context, next)
      : next(),
  );

  const index = serveStatic<ReviewHonoEnv>({
    root,
    path: "index.html",
    onFound: headers,
  });

  outer.get("/", index);
  outer.get("/r/*", index);
  outer.get("/setup", index);

  outer.route("/", app);
  outer.notFound(() => serverJson(404, { ok: false, error: "Not found." }));

  return outer;
}

/** The Desktop callbacks `createReviewApi` takes, answered over the relay. */
export function relayReviewCallbacks(
  relay: ReviewDesktopVerbRelay,
  softwareMapEnabled = false,
) {
  return {
    async open(review: {
      reviewId: string;
      title: string;
    }): Promise<{ softwareMapEnabled: boolean }> {
      const result = await relay.dispatch({
        name: "openApiReview",
        args: review,
      });

      if (!result.ok) throw new ReviewInputError(result.error, 409);

      return z.object({ softwareMapEnabled: z.boolean() }).parse(result.result);
    },
    async capabilities(): Promise<
      Omit<AuthoringCapabilities, "scratchpadEnabled">
    > {
      if (!relay.attached)
        return { desktopAvailable: false, softwareMapEnabled };

      const result = await relay.dispatch({
        name: "authoringCapabilities",
        args: {},
      });

      if (!result.ok) throw new ReviewInputError(result.error, 409);

      return {
        desktopAvailable: true,
        ...z.object({ softwareMapEnabled: z.boolean() }).parse(result.result),
      };
    },
  };
}

function openControlEvents(
  context: Context<ReviewHonoEnv>,
  relay: ReviewDesktopVerbRelay,
): Response {
  let attached = false;

  const response = streamSSE(context, async (output) => {
    let finish!: () => void;

    const disconnected = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const abort = new AbortController();

    let pending: Promise<void> = output
      .write(": attached\n\n")
      .then(() => undefined);

    const writer = {
      signal: abort.signal,
      write(frame: string) {
        pending = pending.then(async () => {
          await output.write(frame);
        });
      },
      close() {
        finish();
        void output.close();
      },
    };

    output.onAbort(() => {
      abort.abort();
      finish();
    });
    attached = relay.attach(writer);

    if (!attached) {
      finish();

      return;
    }

    try {
      await disconnected;
      await pending;
    } finally {
      abort.abort();
    }
  });

  if (!attached) {
    void response.body?.cancel();

    // A new Response: one built on the stream's context would keep its
    // chunked framing beside a Content-Length.
    return serverJson(409, {
      ok: false,
      error: "This server has no room for another Whiteboard Desktop.",
    });
  }

  // Never reused: a kept-alive socket would hold shutdown open after the
  // relay ends the stream.
  response.headers.set("connection", "close");
  response.headers.set("cache-control", "no-cache, no-transform");
  response.headers.set("content-type", "text/event-stream; charset=utf-8");

  return response;
}

export function serverJson<T>(status: number, body: T): Response {
  // SAFETY: callers pass 2xx/4xx/5xx codes (literals, ReviewServerError and
  // HttpJsonError statusCode); none is a bodyless 1xx/204/205/304 status.
  return jsonResponse(body, status as ContentfulStatusCode, {
    cacheControl: "no-store",
  });
}

function httpJsonStatus(cause: unknown): number {
  return cause instanceof HttpJsonError ? cause.statusCode : 400;
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
