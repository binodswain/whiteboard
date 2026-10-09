import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { type JsonObject, isJsonObject } from "@dev.fast/json";
import {
  REVIEW_CLIENT_HEADER,
  REVIEW_CLIENT_REMOTE,
  type ReviewApiSummary,
  type ReviewStructuralDiffEvent,
} from "@dev.fast/review-protocol";
import { errorMessage } from "@dev.fast/trace-core";
import {
  type AgentSelection,
  AgentSelectionSchema,
  selectionMarkdown,
} from "@review/agent-selection.js";
import { type AskAgentStatus, askAgents } from "@review/ask/agents.js";
import { checkoutFiles, mentionableFiles } from "@review/ask/checkout-files.js";
import { parseFileRef, resolveFileRefs } from "@review/ask/file-refs.js";
import {
  type AskAgentId,
  type AskThreadState,
  askAgentIds,
  askChoiceKinds,
  askPicksSchema,
  askQuestionSchema,
} from "@review/ask/thread-state.js";
import type { AskThreads } from "@review/ask/threads.js";
import { watchAskThreads } from "@review/ask/watch.js";
import type { AuthPrincipal } from "@review/auth/index.js";
import { fuzzyRank } from "@review/fuzzy-match.js";
import type { JobRunner } from "@review/jobs/job-runner.js";
import { resolveReviewStackLayers } from "@review/review-stack.js";
import { readBoundedRequestJson } from "@review/server/hono-http.js";
import { HttpJsonError } from "@review/server/http-json.js";
import {
  type WebSettings,
  webSettingsUpdateSchema,
} from "@review/server/web-settings.js";
import {
  type SharingHostEvents,
  mountSharingHost,
} from "@review/sharing/host.js";
import type { SharedReviewStore } from "@review/sharing/import.js";
import { SharedReviewData } from "@review/sharing/routes.js";
import type { ReviewSessionAgent } from "@review/ui-telemetry-events.js";
import { scopedCoverage } from "@review/viewed-coverage.js";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";

import { anchorQuotes } from "./anchor-quotes.js";
import { authoringTools } from "./authoring-tools.js";
import { commentInputSchema } from "./comments.js";
import { documentText } from "./document-text.js";
import { ReviewInputError, sourceReferences } from "./document.js";
import {
  instructionsQuerySchema,
  renderInstructions,
  scratchpadAvailable,
} from "./instructions.js";
import type { LocalReviewData } from "./local-data.js";
import {
  inspectQuerySchema,
  queryAnchor,
  readQuerySchemas,
} from "./read-schemas.js";
import {
  type ReviewRequestVia,
  reviewRequestOrigin,
} from "./request-origin.js";
import {
  type ReviewFilter,
  matchesReviewFilter,
  reviewFilterSchema,
} from "./review-filter.js";
import {
  type UncategorizedReport,
  coverageModeSchema,
  lensReport,
  progressUpdateSchema,
  reviewProgress,
  uncategorizedReport,
} from "./review-progress.js";
import {
  type ReviewStore,
  SCRATCHPAD_ID,
  type Snapshot,
  commandSchema,
  inspectSnapshot,
} from "./store.js";
import { listPinnedTraces, readStoredTrace } from "./traces.js";

export interface AskHost {
  threads: AskThreads;
  agents: () => Promise<AskAgentStatus[]>;
}

const askStartSchema = z.strictObject({
  agent: z.enum(askAgentIds),
  question: askQuestionSchema,
  selection: AgentSelectionSchema,
  picks: askPicksSchema.optional(),
  bypass: z.boolean().optional(),
});

const askPermitSchema = z.strictObject({ bypass: z.boolean() });

/** The threads one watch follows: those of a review's open Asks. A body,
 * not the query, so there can be as many as are open. */
const askWatchSchema = z.strictObject({ threads: z.array(z.string().min(1)) });

const askOpenSchema = z.strictObject({ picks: askPicksSchema.optional() });

const askChoiceSchema = z.strictObject({
  kind: z.enum(askChoiceKinds),
  value: z.string().min(1).max(200),
});

const askFilesSchema = z.strictObject({
  paths: z.array(z.string().min(1).max(400)).max(100),
});

const askFollowUpSchema = z.strictObject({ question: askQuestionSchema });

/** A question with its images: four of up to 5 MB each, base64. */
const ASK_REQUEST_MAX_BYTES = 30 * 1024 * 1024;

const askMentionsSchema = z.object({
  query: z.string().max(400).default(""),
  /** A conversation's checkout, which can be an earlier version's. */
  thread: z.string().optional(),
});

const askOfferQuerySchema = z.object({
  /** The model picked for a question not yet asked. */
  model: askPicksSchema.shape.model,
});

/** How many files a mention picker shows. */
const MENTION_LIMIT = 20;

const askDecisionSchema = z.strictObject({
  permissionId: z.string().min(1),
  optionId: z.string().min(1),
});

const queuedAskSchema = z.strictObject({
  reviewId: z.string().min(1),
  prompt: z.string().min(1).max(20_000),
  createdBy: z.string().min(1).max(200).default("board"),
});

const claimAskSchema = z.strictObject({ runnerId: z.string().min(1).max(200) });

const heartbeatAskSchema = claimAskSchema;

const completeAskSchema = z.strictObject({
  runnerId: z.string().min(1).max(200),
  resultRefs: z.array(z.string().min(1).max(500)).max(500),
});

const failAskSchema = z.strictObject({
  runnerId: z.string().min(1).max(200),
  error: z.string().min(1).max(2000),
});

export interface AuthoringCapabilities {
  desktopAvailable: boolean;
  softwareMapEnabled: boolean;
  /** Off, the host neither makes nor lists the scratchpad, and refuses its id. */
  scratchpadEnabled: boolean;
}

const SCRATCHPAD_DISABLED =
  "The scratchpad is off. Turn it on in Whiteboard Desktop Settings.";

/**
 * What the host reports about reviews, for telemetry. `onReviewCreated` fires
 * again for a replayed create command; consumers dedupe by review id.
 */
export interface ReviewApiHooks {
  onReviewCreated?: (event: {
    reviewId: string;
    kind: "review" | "scratchpad";
    blocks: number;
    via: ReviewRequestVia;
    agentKind?: ReviewSessionAgent;
  }) => void;
  sharing?: SharingHostEvents;
}

/**
 * Remote-mode authorization for the API: who the caller is and whether their
 * GitHub identity can read a repository path. Local mode passes nothing and
 * every check below is skipped.
 */
export interface ReviewApiAccess {
  authenticate(request: Request): Promise<AuthPrincipal | null>;
  canReadRepo(principal: AuthPrincipal, repoPath: string): Promise<boolean>;
  /** The canonical remote URL a `repositoryPath` input names, or undefined
   * for a path that is not a repository on the remote host. */
  normalizeRepoPath?(repoPath: string): string | undefined;
}

/** A gateway forwarding from another machine; it gets no local paths. */
const remoteCaller = (context: Context) =>
  context.req.header(REVIEW_CLIENT_HEADER) === REVIEW_CLIENT_REMOTE;

const LOCAL_BROWSER_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export function isLocalAuthRequest(
  request: Request,
  port: number | undefined,
): boolean {
  if (port === undefined) return false;

  const host = request.headers.get("host");

  if (!host || !LOCAL_BROWSER_HOSTS.some((name) => host === `${name}:${port}`))
    return false;

  const origin = request.headers.get("origin");

  if (origin === null) return true;

  return origin === `http://${host}`;
}

/** Both hosts mount this behind their token authentication. */
export function createReviewApi(
  store: ReviewStore,
  data?: LocalReviewData,
  open?: (review: {
    reviewId: string;
    title: string;
  }) => Promise<{ softwareMapEnabled: boolean }>,
  shared?: SharedReviewStore,
  capabilities: () =>
    | Omit<AuthoringCapabilities, "scratchpadEnabled">
    | Promise<Omit<AuthoringCapabilities, "scratchpadEnabled">> = () => ({
    desktopAvailable: Boolean(open),
    softwareMapEnabled: false,
  }),
  // Synchronous because the catalog is read inside watch callbacks. The host
  // keeps it current from its preferences file.
  scratchpadEnabled: () => boolean = () => false,
  // Read per request: capture can change from outside this server.
  traceEnabled: () => Promise<boolean> = async () => false,
  /** Which server this is, for whiteboard_status. */
  status: () => JsonObject = () => ({}),
  hooks: ReviewApiHooks = {},
  /** Desktop's Ask: local agents answering questions about a selection. */
  ask?: AskHost,
  localBrowserAuth = false,
  webSettings?: {
    read(): Promise<WebSettings>;
    update(patch: Partial<WebSettings>): Promise<WebSettings>;
  },
  headlessOpenUrl?: (reviewId: string) => string,
  jobs?: JobRunner,
  /** Remote-mode repository authorization; absent locally, where the outer
   * token wall remains the whole boundary. */
  access?: ReviewApiAccess,
) {
  const app = new Hono();
  app.onError((error, context) => {
    if (error instanceof HttpJsonError)
      return context.json({ error: error.message }, error.statusCode);

    if (error instanceof ReviewInputError)
      return context.json({ error: error.message }, error.status);

    // A readable message for agents and the canvas; issues stay for programs.
    if (error instanceof z.ZodError)
      return context.json(
        { error: z.prettifyError(error), issues: error.issues },
        400,
      );

    // Provider failures may contain local paths/subprocess output: the server
    // log gets the cause, the response only its kind. Desktop routes this
    // process's stderr to its main log.
    console.error(
      `[Review API] ${context.req.method} ${context.req.path} failed:`,
      error,
    );

    return context.json(
      {
        error: `Whiteboard operation failed (${failureKind(error)}). The server logged the cause; Whiteboard Desktop writes it to main.log in its logs folder.`,
      },
      500,
    );
  });

  // Remote mode authenticates here too — an internal caller such as MCP's
  // fetch carries forwarded headers, so this API answers its own principal.
  // The caller is held for the request's duration, which is how streamed
  // reads still see it after the middleware returns.
  const authScope = access ? new AsyncLocalStorage<AuthPrincipal>() : undefined;

  if (access && authScope)
    app.use("*", async (context, next) => {
      const principal = await access.authenticate(context.req.raw);

      if (!principal) return context.json({ error: "Unauthorized" }, 401);

      return authScope.run(principal, next);
    });

  if (data)
    app.use("*", async (context, next) => {
      if (context.req.method === "GET" && !context.req.query("version"))
        await store.refreshWorktrees();
      await next();
    });

  // Hosted connectors poll these short requests; no connection is held open.
  app.post("/asks", async (context) => {
    const input = queuedAskSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );

    await assertRepoAccess(input.reviewId);
    await readReview(input.reviewId);
    const askId = await store.askQueue.create(input);

    return context.json({ askId }, 202);
  });
  app.get("/asks/pending", async (context) => {
    await store.askQueue.reapExpired();

    const asks = await store.askQueue.pending();
    const visible = await Promise.all(
      asks.map(async (ask) => {
        try {
          await assertRepoAccess(ask.reviewId);
          return ask;
        } catch {
          return null;
        }
      }),
    );

    return context.json({ asks: visible.filter((ask) => ask !== null) });
  });
  app.get("/asks/:askId", async (context) => {
    const ask = await assertAskAccess(context.req.param("askId"));

    return ask
      ? context.json({ ask })
      : context.json({ error: "Ask not found." }, 404);
  });
  app.post("/asks/:askId/claim", async (context) => {
    const { runnerId } = claimAskSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );
    await assertAskAccess(context.req.param("askId"));

    const ask = await store.askQueue.claim(
      context.req.param("askId"),
      runnerId,
    );

    return ask
      ? context.json({ ask })
      : context.json({ error: "Ask is not claimable." }, 409);
  });
  app.post("/asks/:askId/complete", async (context) => {
    const input = completeAskSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );
    await assertAskAccess(context.req.param("askId"));

    const completed = await store.askQueue.complete(
      context.req.param("askId"),
      input.runnerId,
      input.resultRefs,
    );

    return completed
      ? context.json({ ok: true })
      : context.json({ error: "Ask is not owned by this runner." }, 409);
  });
  app.post("/asks/:askId/heartbeat", async (context) => {
    const { runnerId } = heartbeatAskSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );
    await assertAskAccess(context.req.param("askId"));

    const renewed = await store.askQueue.heartbeat(
      context.req.param("askId"),
      runnerId,
    );

    return renewed
      ? context.json({ ok: true })
      : context.json({ error: "Ask is not owned by this runner." }, 409);
  });
  app.post("/asks/:askId/fail", async (context) => {
    const input = failAskSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );
    await assertAskAccess(context.req.param("askId"));

    const failed = await store.askQueue.fail(
      context.req.param("askId"),
      input.runnerId,
      input.error,
    );

    return failed
      ? context.json({ ok: true })
      : context.json({ error: "Ask is not owned by this runner." }, 409);
  });

  if (webSettings) {
    app.get("/settings", async (context) =>
      context.json(await webSettings.read()),
    );
    app.put("/settings", async (context) => {
      const parsed = webSettingsUpdateSchema.safeParse(
        await readBoundedRequestJson(context.req.raw),
      );

      if (!parsed.success)
        return context.json({ error: "Invalid web settings." }, 400);

      return context.json(await webSettings.update(parsed.data));
    });
  }

  const sharedData = shared ? new SharedReviewData(shared) : undefined;
  const isShared = (id: string) => id.startsWith("shared-");

  const sharedCommandSchema = z.object({
    operation: z.object({ reviewId: z.string().optional() }),
  });

  // The host that can show the scratchpad keeps it: Desktop, while the
  // preference is on. Headless servers never make one, and a pad made earlier
  // stays in the store while it is off.
  const ensureScratchpad = async (id?: string) => {
    if (open && scratchpadEnabled() && (!id || id === SCRATCHPAD_ID))
      await store.ensureScratchpad();
  };

  const refuseDisabledScratchpad = (id?: string) => {
    if (id === SCRATCHPAD_ID && !scratchpadEnabled())
      throw new ReviewInputError(SCRATCHPAD_DISABLED, 409);
  };

  const sharedGuard: MiddlewareHandler = async (context, next) => {
    refuseDisabledScratchpad(context.req.param("id"));
    await ensureScratchpad(context.req.param("id"));

    const id = context.req.param("id");

    if (!id || !isShared(id)) return next();

    const query = readQuerySchemas.get.parse({
      version: context.req.query("version"),
    });

    await readReview(id, query.version);

    if (
      context.req.method !== "GET" &&
      !/\/(open|source|copy-context|environment)$/.test(context.req.path) &&
      !/\/workspaces\/[^/]+\/retry$/.test(context.req.path)
    )
      throw new ReviewInputError("Shared reviews are read-only.", 409);

    return next();
  };

  app.use("/:id", sharedGuard);
  app.use("/:id/*", sharedGuard);

  /**
   * Every repository path a snapshot's content can name: its own pins, its
   * target's, and each source reference's explicit pins.
   */
  const reviewRepoPaths = async (
    id: string,
  ): Promise<{ paths: string[]; unresolvable: boolean; missing: boolean }> => {
    let snapshot: Snapshot;

    try {
      snapshot = await readReview(id);
    } catch {
      return { paths: [], unresolvable: false, missing: true };
    }

    const ids = new Set<string>();

    if (snapshot.pins?.repositoryId) ids.add(snapshot.pins.repositoryId);

    if (snapshot.target?.repositoryId) ids.add(snapshot.target.repositoryId);

    for (const { source } of sourceReferences(snapshot.document, {
      tolerant: true,
    }))
      if (source.pins?.repositoryId) ids.add(source.pins.repositoryId);

    const paths: string[] = [];
    let unresolvable = false;

    for (const repoId of ids) {
      const repoPath = await store
        .repositoryPath(repoId)
        .catch(() => undefined);

      if (repoPath === undefined) unresolvable = true;
      else paths.push(repoPath);
    }

    return { paths, unresolvable, missing: false };
  };

  /**
   * Remote mode: the caller must read every repository a review names before
   * any `/:id` route answers. A denied or unresolvable repository answers the
   * same 404 a missing review would, so repository names never leak.
   */
  const assertRepoAccess = async (id: string, principal?: AuthPrincipal) => {
    if (!access || !authScope) return;

    const caller = principal ?? authScope.getStore();

    if (!caller) return;

    const found = await reviewRepoPaths(id);

    if (found.missing) return;

    if (
      found.unresolvable ||
      (
        await Promise.all(
          found.paths.map((repoPath) => access.canReadRepo(caller, repoPath)),
        )
      ).some((allowed) => !allowed)
    )
      throw new ReviewInputError("Review not found.", 404);
  };

  const assertAskAccess = async (askId: string) => {
    const ask = await store.askQueue.get(askId);

    if (ask) await assertRepoAccess(ask.reviewId);

    return ask;
  };

  if (access && authScope) {
    const repoGuard: MiddlewareHandler = async (context, next) => {
      const id = context.req.param("id");

      if (id) await assertRepoAccess(id);

      return next();
    };

    app.use("/:id", repoGuard);
    app.use("/:id/*", repoGuard);

    // Sharing is a local-desktop flow; hosted deployments have no share host
    // sign-in, so /sharing/* endpoints deny like any other unavailable route.
    app.use("/sharing/*", () => {
      throw new ReviewInputError("Review not found.", 404);
    });
  }

  if (shared && data) {
    shared.connect(store, data);
    mountSharingHost(app, store, data, shared, hooks.sharing);
  }

  const readReview = async (
    id: string,
    version?: number,
  ): Promise<Snapshot> => {
    if (!id.startsWith("shared-")) return store.read(id, version);
    const snapshot = shared?.get(id).snapshot;

    if (!snapshot || (version !== undefined && version !== snapshot.version))
      throw new ReviewInputError("Shared review version is unavailable.", 404);

    return snapshot;
  };

  const catalog = async (
    mode: "structural" | "textual" = "structural",
    principal?: AuthPrincipal,
    filter: ReviewFilter = {},
  ) => {
    const local = await store.list(mode, filter);

    const sharedSummaries = ((await shared?.list(mode)) ?? []).filter(
      (summary) => matchesReviewFilter(summary, filter),
    );

    const summaries = [
      ...(scratchpadEnabled()
        ? local
        : local.filter((summary) => summary.kind !== "scratchpad")),
      ...sharedSummaries,
    ];

    if (!access || !principal) return summaries;

    // One verdict per repository path, shared across summaries.
    const verdicts = new Map<string, Promise<boolean>>();

    const allowed = (repoPath: string) => {
      let verdict = verdicts.get(repoPath);

      if (!verdict) {
        verdict = access.canReadRepo(principal, repoPath);
        verdicts.set(repoPath, verdict);
      }

      return verdict;
    };

    // The list join exposes pins.repositoryId's path; a review whose
    // repositories only its target names is checked through the id. A
    // repository id that no longer resolves hides the summary rather than
    // risk leaking one its row rename detached.
    const visible = async (summary: ReviewApiSummary) => {
      const paths = new Set<string>();
      const repoIds = new Set<string>();

      if (summary.repositoryPath) paths.add(summary.repositoryPath);

      if (summary.pins?.repositoryId) repoIds.add(summary.pins.repositoryId);

      if (summary.target?.repositoryId)
        repoIds.add(summary.target.repositoryId);

      for (const repoId of repoIds) {
        const repoPath = await store
          .repositoryPath(repoId)
          .catch(() => undefined);

        if (repoPath === undefined) return false;

        paths.add(repoPath);
      }

      for (const repoPath of paths)
        if (!(await allowed(repoPath))) return false;

      return true;
    };

    const flags = await Promise.all(summaries.map(visible));

    return summaries.filter((_, index) => flags[index]);
  };

  app.get("/", async (context) => {
    await ensureScratchpad();

    return context.json(
      await catalog(
        coverageModeSchema.parse(context.req.query("mode")),
        authScope?.getStore(),
        reviewFilterSchema.parse(context.req.query()),
      ),
    );
  });

  app.get("/repositories", async (context) => {
    const principal = authScope?.getStore();

    const repositories = (await store.repositories()).map(
      ({ id, path: root }) => ({ id, name: path.basename(root), path: root }),
    );

    if (!access || !principal)
      return context.json(repositories.map(({ id, name }) => ({ id, name })));

    const visible = await Promise.all(
      repositories.map(async (repo) =>
        (await access.canReadRepo(principal, repo.path)) ? repo : null,
      ),
    );

    return context.json(
      visible
        .filter((repo): repo is NonNullable<typeof repo> => repo !== null)
        .map(({ id, name }) => ({ id, name })),
    );
  });

  // Server-owned state only: asking the Desktop canvas would let a stalled
  // renderer block tool listing and the first instructions call.
  const instructionContext = async () => ({
    desktopAvailable: Boolean(open),
    scratchpadEnabled: scratchpadEnabled(),
    traceEnabled: await traceEnabled(),
  });

  app.get("/authoring", async (context) => {
    const instructions = await instructionContext();

    return context.json(
      authoringTools(
        scratchpadAvailable(instructions),
        instructions.traceEnabled,
      ).filter(
        ({ name }) =>
          jobs || !["generate_review", "review_job_status"].includes(name),
      ),
    );
  });

  if (jobs) {
    app.post("/jobs", async (context) => {
      const input = z
        .strictObject({
          repository: z.string().trim().min(1),
          base: z.string().trim().min(1),
          head: z.string().trim().min(1),
        })
        .parse(await readBoundedRequestJson(context.req.raw));

      const principal = authScope?.getStore();

      if (access && principal) {
        const repoPath = access.normalizeRepoPath?.(input.repository);

        if (!repoPath || !(await access.canReadRepo(principal, repoPath)))
          throw new ReviewInputError("Repository not found.", 404);
      }

      const job = await jobs.submit({
        repo: input.repository,
        baseSha: input.base,
        headSha: input.head,
      });

      const status = {
        status: job.status,
        ...(job.id && { jobId: job.id }),
        ...(job.reviewId && { reviewId: job.reviewId }),
        ...(job.url && { url: job.url }),
        ...(job.error && { error: job.error }),
      };

      return context.json(
        status,
        job.status === "succeeded" || job.status === "failed" ? 200 : 202,
      );
    });
    app.get("/jobs/:jobId", async (context) => {
      const job = await jobs.get(context.req.param("jobId"));

      if (!job) return context.json({ error: "Review job not found." }, 404);

      const principal = authScope?.getStore();

      if (access && principal) {
        const repoPath = access.normalizeRepoPath?.(job.input.repo);

        if (!repoPath || !(await access.canReadRepo(principal, repoPath)))
          throw new ReviewInputError("Review job not found.", 404);
      }

      return context.json({
        status: job.status,
        ...(job.id && { jobId: job.id }),
        ...(job.reviewId && { reviewId: job.reviewId }),
        ...(job.url && { url: job.url }),
        ...(job.error && { error: job.error }),
      });
    });
  }

  app.get("/instructions", async (context) => {
    const { topic } = instructionsQuerySchema.parse(context.req.query());

    return context.json(
      await renderInstructions(topic, await instructionContext()),
    );
  });
  app.get("/:id/progress", async (context) => {
    if (!data) throw new ReviewInputError("Source data is unavailable.", 409);

    const query = readQuerySchemas.get
      .pick({ version: true })
      .extend({
        mode: coverageModeSchema,
        wait: z.enum(["false", "true"]).default("true"),
      })
      .parse(context.req.query());

    const snapshot = await readReview(context.req.param("id"), query.version);

    const documentPins =
      query.wait === "false" && snapshot.pins
        ? (await data.resolveSource(snapshot)).pins
        : undefined;

    if (documentPins) {
      const state = data.coverageSnapshot(
        snapshot.reviewId,
        documentPins,
        query.mode,
      );

      if (state.pending)
        return context.json(
          await reviewProgress(
            store,
            data,
            snapshot,
            context.req.raw.signal,
            query.mode,
            state.comparison,
          ),
          202,
        );
    }

    return context.json(
      await reviewProgress(
        store,
        data,
        snapshot,
        context.req.raw.signal,
        query.mode,
      ),
    );
  });
  app.post("/:id/progress", async (context) => {
    if (!data) throw new ReviewInputError("Source data is unavailable.", 409);

    const input = progressUpdateSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );

    const id = context.req.param("id");

    const snapshot = await store.read(id);

    const progress = await reviewProgress(
      store,
      data,
      snapshot,
      context.req.raw.signal,
      input.mode,
    );

    const files = input.files.map((update) => {
      const file = progress.files.find((file) => file.path === update.path);

      if (!file || file.fingerprint !== update.fingerprint)
        throw new ReviewInputError(
          "This file changed. Reload before marking it viewed.",
          409,
        );

      return {
        path: file.path,
        fingerprint: file.fingerprint,
        scope: scopedCoverage(file, update.sources),
      };
    });

    if ((await store.read(id)).version !== snapshot.version)
      throw new ReviewInputError(
        "Review changed during this update. Try again.",
        409,
      );
    await store.updateViewedCoverage(id, files, input.viewed);

    return context.json(
      await reviewProgress(
        store,
        data,
        await store.read(id, input.version),
        context.req.raw.signal,
        input.mode,
      ),
    );
  });
  // A lens author's cheap read: the lenses as authored, what each resolves
  // to, and the changed lines no lens selects yet.
  app.get("/:id/lenses", async (context) => {
    if (!data) throw new ReviewInputError("Source data is unavailable.", 409);

    const snapshot = await readReview(context.req.param("id"));

    return context.json({
      version: snapshot.version,
      ...lensReport(
        snapshot.lenses ?? [],
        await reviewProgress(store, data, snapshot, context.req.raw.signal),
      ),
    });
  });
  app.get("/status", async (context) =>
    context.json({
      ...status(),
      desktopAvailable: (await capabilities()).desktopAvailable,
    }),
  );

  app.get("/capabilities", async (context) =>
    context.json({
      ...(await capabilities()),
      scratchpadEnabled: scratchpadEnabled(),
      localBrowserAuth,
    }),
  );

  app.get("/:id/activity", async (context) => {
    const id = context.req.param("id");
    await readReview(id);

    return context.json(
      isShared(id)
        ? { workingCount: 0, expiresAt: null }
        : await store.activity.read(id),
    );
  });

  // One route per agent tool; the path names the action.
  for (const action of ["begin", "update", "end"] as const)
    app.post(`/:id/activity/${action}`, async (context) => {
      const input = await readBoundedRequestJson(context.req.raw);
      const id = context.req.param("id");
      await store.assertExists(id);

      return context.json(
        await store.activity.update(
          id,
          isJsonObject(input) ? { ...input, action } : input,
        ),
      );
    });
  app.get("/watch", async (context) => {
    const query = context.req.query("subscriptions");

    // The stream's reads run after the middleware returned; keep the caller.
    const principal = authScope?.getStore();

    if (query !== undefined) {
      let input: unknown;

      try {
        input = JSON.parse(query);
      } catch {
        throw new ReviewInputError("Invalid subscriptions.");
      }

      const subscriptions = z
        .array(
          z.strictObject({
            reviewId: z.string().min(1).nullable(),
            mode: coverageModeSchema,
          }),
        )
        .parse(input);

      // Only entries whose review (or the catalog) changed are re-read and re-sent.
      const dirty = new Set(subscriptions.keys());

      const mark = (id: string | null) => {
        let marked = false;

        subscriptions.forEach((item, index) => {
          if (item.reviewId === id) {
            dirty.add(index);
            marked = true;
          }
        });

        return marked;
      };

      return watch(
        async () =>
          Promise.all(
            subscriptions.map(async ({ reviewId, mode }, index) => {
              if (!dirty.delete(index)) return null;

              try {
                return {
                  value:
                    reviewId === null
                      ? await catalog(mode, principal)
                      : await (async () => {
                          await assertRepoAccess(reviewId, principal);

                          return {
                            ...(await readReview(reviewId)),
                            activity: await store.activity.read(reviewId),
                            coverageRevision: data?.coverageRevision ?? 0,
                          };
                        })(),
                };
              } catch (error) {
                return {
                  error:
                    error instanceof ReviewInputError
                      ? error.message
                      : "Could not read review.",
                };
              }
            }),
          ),
        (notify) => {
          const stopRefresh = store.watchWorktrees();

          const stops = [
            stopRefresh,
            data?.subscribeCoverage(() => {
              subscriptions.forEach((item, index) => {
                if (item.reviewId !== null) dirty.add(index);
              });

              // Coverage never changes the catalog; don't send an all-null line.
              if (dirty.size > 0) notify();
            }) ?? (() => {}),
            store.subscribe((result) => {
              if (mark(result.reviewId)) notify();
            }),
            store.activity.subscribe((id) => {
              if (mark(id)) notify();
            }),
            store.activity.subscribeWorking(() => {
              if (mark(null)) notify();
            }),
            shared?.subscribe(() => {
              if (mark(null)) notify();
            }) ?? (() => {}),
            store.subscribeCatalog(() => {
              if (mark(null)) notify();
            }),
          ];

          return () => stops.forEach((stop) => stop());
        },
        // A missing review is an {error} entry here, never a 404.
        () => {},
      );
    }

    await ensureScratchpad();

    return watch(
      () =>
        catalog(coverageModeSchema.parse(context.req.query("mode")), principal),
      (notify) => {
        const local = store.subscribeCatalog(notify);
        const activity = store.activity.subscribeWorking(notify);
        const imported = shared?.subscribe(notify);

        return () => {
          local();
          activity();
          imported?.();
        };
      },
    );
  });

  /** Show a review in Desktop and start preparing its pinned checkouts. */
  const openReview = async (review: Snapshot) => {
    if (headlessOpenUrl && !(await capabilities()).desktopAvailable)
      return { opened: false, url: headlessOpenUrl(review.reviewId) };

    if (!open) throw new ReviewInputError("The desktop is not connected.", 409);

    const settings = await open({
      reviewId: review.reviewId,
      title: review.title,
    });

    let environmentIssues: { side?: string; message: string }[] | undefined;

    try {
      if (review.target?.kind === "commits" && review.pins)
        void data?.workspaces
          .open(review.reviewId, review.pins)
          .catch(() => {});
      environmentIssues = await data?.currentEnvironmentIssues(review);
    } catch (error) {
      environmentIssues = [
        {
          message: `Could not check language checkouts: ${errorMessage(error)}. Recheck with review_environment.`,
        },
      ];
    }

    return {
      ...settings,
      environmentIssues: environmentIssues?.length
        ? environmentIssues
        : undefined,
    };
  };

  /**
   * A created or returned review is shown where Desktop can, unless the author asked
   * not to. The review is already saved, so a failed open is reported, not thrown.
   */
  const openCreated = async (reviewId: string) => {
    try {
      if (!open || !(await capabilities()).desktopAvailable)
        return { opened: false };

      return {
        opened: true,
        ...(await openReview(await store.read(reviewId))),
      };
    } catch (error) {
      return {
        opened: false,
        openError: `${errorMessage(error)} Retry with review_open.`,
      };
    }
  };

  app.post("/:id/open", async (context) => {
    const id = context.req.param("id");

    if (isShared(id)) await shared?.assertReady(id);

    return context.json({
      ok: true,
      ...(await openReview(await readReview(id))),
    });
  });
  app.get("/:id/watch", async (context) => {
    const id = context.req.param("id");

    // Activity changes every renewal; reload the document only when it changed.
    let document: Snapshot | undefined;

    return watch(
      async () => ({
        ...(document ??= await readReview(id)),
        activity: isShared(id)
          ? { workingCount: 0, expiresAt: null }
          : await store.activity.read(id),
      }),
      (notify) => {
        const stopRefresh = store.watchWorktrees();

        const stopDocument = store.subscribe((result) => {
          if (result.reviewId === id) {
            document = undefined;
            notify();
          }
        });

        const stopActivity = store.activity.subscribe((changed) => {
          if (changed === id) notify();
        });

        return () => {
          stopRefresh();
          stopDocument();
          stopActivity();
        };
      },
    );
  });

  if (data) {
    const traceQuery = readQuerySchemas.maps.extend({
      storage: z.enum(["s3", "hosted"]).optional(),
      trace: z.string().min(1).optional(),
    });

    // Traces are stored beside the review's own repository.
    const tracePins = async (id: string, version?: number) => {
      const { pins } = await readReview(id, version);

      if (!pins)
        throw new ReviewInputError(
          "This document has no source pins of its own.",
          409,
        );

      return pins;
    };

    app.get("/:id/agent-traces", async (context) => {
      const query = traceQuery.parse(context.req.query());
      const pins = await tracePins(context.req.param("id"), query.version);

      return context.json(
        await listPinnedTraces(
          await store.repositoryPath(pins.repositoryId),
          pins,
          query.storage,
        ),
      );
    });
    app.get("/:id/agent-traces/:sessionId", async (context) => {
      const query = traceQuery.parse(context.req.query());
      const pins = await tracePins(context.req.param("id"), query.version);

      const result = await readStoredTrace(
        await store.repositoryPath(pins.repositoryId),
        context.req.param("sessionId"),
        query.trace,
        query.storage,
      );

      if (!result.ok)
        return context.json({ ok: false, error: result.error }, result.status);

      return context.json(result);
    });
    app.post("/:id/navigator", async (context) => {
      if (remoteCaller(context))
        throw new ReviewInputError(
          "Source windows are not available for a review on another machine.",
          409,
        );

      const input = readQuerySchemas.file
        .extend({
          side: z.enum(["base", "head"]).default("head"),
          file: z.string().min(1).optional(),
          empty: z.literal("true").optional(),
        })
        .parse(context.req.query());

      return context.json(
        await data.navigatorWorkspace(
          await readReview(context.req.param("id"), input.version),
          {
            ...input,
            empty: input.empty === "true",
            anchor: queryAnchor(input),
          },
        ),
      );
    });
    app.get("/:id/tree", async (context) => {
      const input = readQuerySchemas.tree.parse(context.req.query());

      const { pins } = await data.resolveSource(
        await readReview(context.req.param("id"), input.version),
        input.commit,
        queryAnchor(input),
      );

      return context.json(await data!.tree(pins, input.side, input.path));
    });
    app.get("/:id/maps/:resourceId", async (context) => {
      const query = readQuerySchemas.maps.parse(context.req.query());
      const id = context.req.param("id");

      if (id && isShared(id))
        return context.json(
          sharedData!.map(
            id,
            z.string().parse(context.req.param("resourceId")),
          ),
        );

      return context.json(
        await data.map(
          await data.sourcePins(await readReview(id, query.version)),
          z.string().parse(context.req.param("resourceId")),
        ),
      );
    });
    app.post("/repositories", async (context) => {
      const input = z
        .strictObject({ path: z.string().min(1) })
        .parse(await readBoundedRequestJson(context.req.raw));

      if (access) {
        const principal = authScope!.getStore()!;
        const remote = access.normalizeRepoPath?.(input.path);

        if (!remote)
          throw new ReviewInputError(
            "Remote deployments register GitHub repository URLs.",
            400,
          );

        if (!(await access.canReadRepo(principal, remote)))
          throw new ReviewInputError("Repository is not registered.", 404);

        return context.json(await store.registerRemoteRepository(remote));
      }

      return context.json(await data!.register(input.path));
    });
    app.post("/resources", async (context) =>
      context.json(
        await data!.upload(
          await readBoundedRequestJson(context.req.raw, 8 * 1024 * 1024),
        ),
      ),
    );
    app.get("/:id/resources/:resourceId", async (context) => {
      const id = context.req.param("id");
      const snapshot = await readReview(id);

      const resource =
        id && isShared(id)
          ? {
              ...(await sharedData!.resource(
                id,
                z.string().parse(context.req.param("resourceId")),
              )),
              repositoryId: snapshot.pins?.repositoryId ?? "",
            }
          : await store.resource(
              z.string().parse(context.req.param("resourceId")),
            );

      // A document with pins serves only its repository's resources.
      if (snapshot.pins && resource.repositoryId !== snapshot.pins.repositoryId)
        throw new ReviewInputError("Resource is outside this repository.", 404);

      return new Response(Buffer.from(resource.data), {
        headers: {
          "content-type": resource.mimeType,
          "x-content-type-options": "nosniff",
        },
      });
    });
    app.get("/:id/language-context", async (context) => {
      const input = readQuerySchemas.maps
        .extend({
          side: z.enum(["base", "head"]).default("head"),
          commit: z.string().optional(),
          repositoryId: z.string().optional(),
          head: z.string().optional(),
          base: z.string().optional(),
        })
        .parse(context.req.query());

      const snapshot = await readReview(context.req.param("id"), input.version);

      const environment = await data.languageEnvironment(
        snapshot,
        input.side,
        input.commit,
        false,
        queryAnchor(input),
      );

      return context.json(
        remoteCaller(context)
          ? {
              // A live checkout's identity names its path; keep only its equality.
              identity: createHash("sha256")
                .update(environment.identity)
                .digest("hex"),
              // An acquisition error can quote local paths.
              ...(environment.issue && {
                issue:
                  "The checkout for language features is not available on the remote machine.",
              }),
            }
          : environment,
      );
    });
    app.post("/:id/environment", async (context) => {
      const input = z
        .strictObject({ retry: z.boolean().optional() })
        .parse(await readBoundedRequestJson(context.req.raw));

      return context.json({
        issues: await data.environmentIssues(
          await readReview(context.req.param("id")),
          input.retry,
        ),
      });
    });
    app.post("/workspace-cleanup", async (context) => {
      const input = z
        .strictObject({ workspaceId: z.string().min(1).optional() })
        .parse(await readBoundedRequestJson(context.req.raw));

      if (input.workspaceId)
        await data.workspaces.retryCleanup(input.workspaceId);

      return context.json({ failures: await data.workspaces.failures() });
    });
    app.get("/:id/workspaces", async (context) => {
      await readReview(context.req.param("id"));

      return context.json(await data.workspaces.list(context.req.param("id")));
    });
    app.post("/:id/workspaces/:workspaceId/retry", async (context) => {
      return context.json(
        await data.workspaces.retry(
          context.req.param("id"),
          context.req.param("workspaceId"),
        ),
      );
    });
    app.get("/:id/file", async (context) => {
      // Browsing can describe binaries; authoring reads still require text.
      const input = readQuerySchemas.file
        .extend({ binary: z.literal("describe").optional() })
        .parse(context.req.query());

      const id = context.req.param("id");

      const anchor = queryAnchor(input);

      const { snapshot, pins } = await data.resolveSource(
        await readReview(id, input.version),
        input.commit,
        anchor,
      );

      const file = await data.file(
        pins,
        input.side,
        input.file,
        input.binary === "describe",
      );

      if (file.text.includes("\0")) {
        return context.json({
          binary: true,
          file: file.file,
          side: file.side,
          commit: file.commit,
        });
      }

      const local =
        !remoteCaller(context) &&
        !input.commit &&
        !anchor &&
        input.side === "head" &&
        snapshot.target?.kind === "worktree"
          ? await data.liveFile(pins.repositoryId, input.file, file.text)
          : undefined;

      return context.json({ ...file, ...local });
    });
    app.get("/:id/structural-diff", async (context) => {
      const input = readQuerySchemas.structuralDiff.parse(context.req.query());
      const id = context.req.param("id");

      const { pins } = await data.resolveSource(
        await readReview(id, input.version),
        input.commit,
        queryAnchor(input),
      );

      const abort = new AbortController();
      const encoder = new TextEncoder();

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: ReviewStructuralDiffEvent) => {
            if (!abort.signal.aborted)
              controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          };

          try {
            for await (const event of data.structuralChanges({
              reviewId: id,
              pins,
              signal: AbortSignal.any([context.req.raw.signal, abort.signal]),
              file: input.file,
            }))
              send(event);
          } catch (error) {
            send({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          } finally {
            if (!abort.signal.aborted) controller.close();
          }
        },
        cancel() {
          abort.abort();
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "application/x-ndjson",
          "cache-control": "no-store",
        },
      });
    });
    app.get("/:id/diff", async (context) => {
      const input = readQuerySchemas.diff.parse(context.req.query());

      const { pins } = await data.resolveSource(
        await readReview(context.req.param("id"), input.version),
        input.commit,
        queryAnchor(input),
      );

      return context.json(await data.changes(pins));
    });
    app.get("/:id/commits", async (context) => {
      const input = readQuerySchemas.commits.parse(context.req.query());

      return context.json(
        await data.commits(
          (
            await data.resolveSource(
              await readReview(context.req.param("id"), input.version),
            )
          ).pins,
        ),
      );
    });
  }

  app.post("/:id/copy-context", async (context) => {
    const query = readQuerySchemas.get
      .pick({ version: true })
      .extend({ mode: coverageModeSchema })
      .parse(context.req.query());

    const selection = AgentSelectionSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );

    return context.json({
      text: await selectionContext(
        context.req.param("id"),
        selection,
        query.version,
      ),
    });
  });

  /** The Markdown an agent gets for a selection, copied or asked about. */
  async function selectionContext(
    reviewId: string,
    selection: AgentSelection,
    version?: number,
  ) {
    if (selection.apiSource && selection.apiSource.reviewId !== reviewId)
      throw new ReviewInputError("Selection belongs to another review.");

    const snapshot = await readReview(
      reviewId,
      selection.apiSource?.version ?? version,
    );

    const target = selection.target;
    let excerpt = "";

    if (target.kind === "code" && !selection.selectedDiff) {
      if (!data) throw new ReviewInputError("Source data is unavailable.", 409);

      const source = await data.quote(
        (
          await data.resolveSource(
            snapshot,
            selection.apiSource?.commit,
            selection.apiSource?.pins,
          )
        ).pins,
        {
          side: target.side,
          file: target.path,
          fromLine: target.startLine,
          toLine: target.endLine,
        },
      );

      excerpt =
        `## ${target.side}: ${target.path}:${target.startLine}-${target.endLine} (${source.commit})\n` +
        source.text
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n");
    }

    const diff = selection.selectedDiff;

    const text = selectionMarkdown(
      selection,
      excerpt,
      diff
        ? { base: `a/${diff.oldPath}`, head: `b/${diff.newPath}` }
        : undefined,
    );

    return [
      `Selected ${target.kind === "text" ? "text" : "code"} from Whiteboard: ${snapshot.title}`,
      `Session ID: ${snapshot.reviewId}`,
      `Version: ${snapshot.version}`,
      ...(selection.apiSource?.commit
        ? [`Selected commit: ${selection.apiSource.commit}`]
        : []),
      ...(selection.apiSource?.pins
        ? [
            `Selected repository ID: ${selection.apiSource.pins.repositoryId}`,
            ...(selection.apiSource.pins.base
              ? [`Selected base: ${selection.apiSource.pins.base}`]
              : []),
            `Selected head: ${selection.apiSource.pins.head}`,
          ]
        : []),
      ...(snapshot.pins
        ? [
            `Repository ID: ${snapshot.pins.repositoryId}`,
            `Session base: ${snapshot.pins.base}`,
            `Session head: ${snapshot.pins.head}`,
          ]
        : []),
      `Read this version with session_get({"sessionId":"${snapshot.reviewId}","version":${snapshot.version},"full":true}).`,
      "",
      text,
      "",
      "",
    ].join("\n");
  }

  if (ask && data) {
    const readThread = (reviewId: string, threadId: string) => {
      const thread = ask.threads.get(threadId);

      if (!thread || thread.reviewId !== reviewId)
        throw new ReviewInputError("This conversation has ended.", 404);

      return thread;
    };

    /** What an agent reads before a session's first question: the review,
     * the checkout, and the selection. */
    const askContext = async (
      agent: AskAgentId,
      snapshot: Snapshot,
      checkout: { head: string; live: boolean },
      selection: AgentSelection,
      version: number | undefined,
    ) => {
      const reach = await ask.threads.reach(agent);
      const { reviewId } = snapshot;

      return [
        `A reviewer is reading "${snapshot.title}" in Whiteboard and has a question about a selection.`,
        checkout.live
          ? "Your working directory is the repository the review describes."
          : `Your working directory is a checkout of the review's head commit, ${checkout.head}. Answer from this code, not from other branches.`,
        "Answer the question for a staff engineer: lead with the answer and keep it short. Explain at the level of components and data flow before functions, and check each claim about the code against code you have read.",
        "Name files by their path from the checkout root, with a line where it helps, as in `src/app.ts:42`; the reviewer can open them from your answer.",
        ...(reach?.kind === "mcp"
          ? [
              `The whiteboard MCP tools read and change this review: its sessionId is "${reviewId}". Read it with session_get. If the reviewer asks you to change the review, first read session_get_instructions({}) for its guidelines and each component's fields (the review exists, so skip creating one), then edit it with session_edit; do not write files to do it.`,
            ]
          : reach?.kind === "cli"
            ? [
                `Whiteboard's CLI reads and changes this review from your shell: its sessionId is "${reviewId}". Read it with \`${reach.command} api session_get '{"sessionId":"${reviewId}"}'\`. If the reviewer asks you to change the review, first read \`${reach.command} api session_get_instructions '{}'\` for its guidelines and each component's fields (the review exists, so skip creating one), then edit it with \`${reach.command} api session_edit '<json>'\`; do not write files to do it. \`${reach.command} api tools\` lists each tool's input.`,
              ]
            : []),
        "",
        await selectionContext(reviewId, selection, version),
      ].join("\n");
    };

    // The agents answering in any review, which quitting the app would stop.
    app.get("/ask/working", (context) =>
      context.json({ agents: ask.threads.working() }),
    );

    // Each agent with the models and efforts it offered last; none until
    // it has run.
    app.get("/:id/ask/agents", async (context) =>
      context.json({ agents: await ask.agents() }),
    );

    // What an agent offers: what it said last, else what a session
    // started in the review's checkout says. With another model it offers,
    // what it said last with that model, else what such a session says once
    // it has the model: the efforts on offer depend on it.
    app.get("/:id/ask/agents/:agent/offer", async (context) => {
      const agent = z.enum(askAgentIds).parse(context.req.param("agent"));
      const { model } = askOfferQuerySchema.parse(context.req.query());
      const stored = await store.askHistory.offer(agent);

      // An offer of nothing to choose was saved before the agent's
      // settings were known; the agent says again.
      const last =
        stored && Object.keys(stored.choices).length ? stored : undefined;

      const models = last?.choices.model;

      const another =
        model !== undefined &&
        model !== models?.current &&
        (!models || models.options.some((option) => option.value === model));

      const known = another ? await store.askHistory.offer(agent, model) : last;

      if (known) return context.json({ offer: known });

      const checkout = await data.agentCheckout(
        await readReview(context.req.param("id")),
      );

      const offer = await ask.threads.offered(
        agent,
        checkout.rootPath,
        another ? model : undefined,
      );

      if (last) await store.askHistory.saveModelOffer(agent, offer);
      else await store.askHistory.saveOffer(agent, offer);

      return context.json({ offer });
    });

    // The checkout's files a mention could mean, best first.
    app.get("/:id/ask/mentions", async (context) => {
      const reviewId = context.req.param("id");

      const { query, thread } = askMentionsSchema.parse(context.req.query());

      const cwd = thread
        ? readThread(reviewId, thread).read().cwd
        : (await data.agentCheckout(await readReview(reviewId))).rootPath;

      const files = fuzzyRank(query, await mentionableFiles(cwd), (file) => [
        file,
        file.slice(file.lastIndexOf("/") + 1),
      ]);

      return context.json({ paths: files.slice(0, MENTION_LIMIT) });
    });

    app.post("/:id/ask", async (context) => {
      const reviewId = context.req.param("id");

      const { version } = readQuerySchemas.get
        .pick({ version: true })
        .parse(context.req.query());

      const input = askStartSchema.parse(
        await readBoundedRequestJson(context.req.raw, ASK_REQUEST_MAX_BYTES),
      );

      const snapshot = await readReview(reviewId, version);
      const checkout = await data.agentCheckout(snapshot);
      const target = input.selection.target;
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();

      const thread = ask.threads.open({
        id,
        reviewId,
        agent: input.agent,
        // Saved once the agent has a session to reopen; a later one
        // replaces a session the agent could not reopen.
        onSession: (sessionId) =>
          void (async () => {
            if (await store.askHistory.get(id))
              await store.askHistory.updateSession(id, sessionId);
            else
              await store.askHistory.save({
                id,
                reviewId,
                agent: input.agent,
                sessionId,
                version: snapshot.version,
                head: checkout.head,
                cwd: checkout.rootPath,
                selection: input.selection,
                title: input.question.text.slice(0, 200),
                createdAt,
                updatedAt: createdAt,
                bypass: input.bypass,
              });
          })().catch(() => {}),
        onTurn: () => void store.askHistory.touch(id).catch(() => {}),
        onSave: (entries) =>
          void store.askHistory.saveEntries(id, entries).catch(() => {}),
        picks: input.picks,
        bypass: input.bypass,
        onBypass: (bypass) =>
          void store.askHistory.setBypass(id, bypass).catch(() => {}),
        onOffer: (offer) =>
          void store.askHistory.saveOffer(input.agent, offer).catch(() => {}),
        onTitle: (title) =>
          void store.askHistory.rename(id, title).catch(() => {}),
        cwd: checkout.rootPath,
        head: checkout.head,
        selection: {
          title: input.selection.title,
          quote: target.kind === "text" ? target.quote : undefined,
        },
        context: await askContext(
          input.agent,
          snapshot,
          checkout,
          input.selection,
          version,
        ),
        question: input.question,
      });

      return context.json({ threadId: thread.id });
    });

    app.get("/:id/ask/threads", async (context) => {
      const reviewId = context.req.param("id");

      await readReview(reviewId);

      return context.json({ threads: await store.askHistory.list(reviewId) });
    });

    // The threads of every open Ask in a review, over one connection. Before
    // the route for one thread, which would read `watch` as its id.
    app.post("/:id/ask/watch", async (context) => {
      const reviewId = context.req.param("id");

      await readReview(reviewId);

      const { threads } = askWatchSchema.parse(
        await readBoundedRequestJson(context.req.raw),
      );

      return watchAskThreads(
        new Map(
          threads.map((threadId) => {
            const thread = ask.threads.get(threadId);

            return [
              threadId,
              thread?.reviewId === reviewId ? thread : undefined,
            ];
          }),
        ),
      );
    });

    // A saved conversation, without starting its agent.
    app.get("/:id/ask/:threadId", async (context) => {
      const record = await store.askHistory.get(context.req.param("threadId"));

      if (record?.reviewId !== context.req.param("id"))
        throw new ReviewInputError("This conversation was not found.", 404);
      const target = record.selection.target;

      return context.json({
        id: record.id,
        agent: record.agent,
        agentName: askAgents[record.agent].name,
        status: "idle",
        readOnly: true,
        bypass: false,
        head: record.head,
        cwd: record.cwd,
        title: record.title,
        selection: {
          title: record.selection.title,
          quote: target.kind === "text" ? target.quote : undefined,
        },
        entries: record.entries ?? [],
      } satisfies AskThreadState);
    });

    // A saved conversation: attach to it if it is still running, else start
    // the agent and load it, at the commit it was asked about.
    app.post("/:id/ask/:threadId/open", async (context) => {
      const reviewId = context.req.param("id");
      const threadId = context.req.param("threadId");
      const live = ask.threads.get(threadId);

      if (live?.reviewId === reviewId) return context.json({ threadId });
      const record = await store.askHistory.get(threadId);

      const { picks } = askOpenSchema.parse(
        await readBoundedRequestJson(context.req.raw, undefined, {}),
      );

      if (record?.reviewId !== reviewId)
        throw new ReviewInputError("This conversation was not found.", 404);

      const snapshot = await readReview(reviewId, record.version);
      const checkout = await data.agentCheckout(snapshot);
      const target = record.selection.target;

      ask.threads.open({
        id: record.id,
        reviewId,
        agent: record.agent,
        cwd: checkout.rootPath,
        head: checkout.head,
        selection: {
          title: record.selection.title,
          quote: target.kind === "text" ? target.quote : undefined,
        },
        resume: { sessionId: record.sessionId, entries: record.entries },
        // For a new session, should the agent no longer have this one.
        context: await askContext(
          record.agent,
          snapshot,
          checkout,
          record.selection,
          record.version,
        ),
        onSession: (sessionId) =>
          void store.askHistory
            .updateSession(record.id, sessionId)
            .catch(() => {}),
        onTurn: () => void store.askHistory.touch(record.id).catch(() => {}),
        onSave: (entries) =>
          void store.askHistory.saveEntries(record.id, entries).catch(() => {}),
        picks,
        bypass: record.bypass,
        onBypass: (bypass) =>
          void store.askHistory.setBypass(record.id, bypass).catch(() => {}),
        onOffer: (offer) =>
          void store.askHistory.saveOffer(record.agent, offer).catch(() => {}),
        onTitle: (title) =>
          void store.askHistory.rename(record.id, title).catch(() => {}),
      });

      return context.json({ threadId: record.id });
    });

    app.post("/:id/ask/:threadId/prompt", async (context) => {
      const thread = readThread(
        context.req.param("id"),
        context.req.param("threadId"),
      );

      const { question } = askFollowUpSchema.parse(
        await readBoundedRequestJson(context.req.raw, ASK_REQUEST_MAX_BYTES),
      );

      const refusal = thread.askRefusal();

      if (refusal) throw new ReviewInputError(refusal, 409);

      void thread.ask(question);

      return context.json({ ok: true });
    });

    app.post("/:id/ask/:threadId/permission", async (context) => {
      const thread = readThread(
        context.req.param("id"),
        context.req.param("threadId"),
      );

      const decision = askDecisionSchema.parse(
        await readBoundedRequestJson(context.req.raw),
      );

      if (!thread.decide(decision.permissionId, decision.optionId))
        throw new ReviewInputError("This request was already answered.", 409);

      return context.json({ ok: true });
    });

    // The files an answer names, as the checkout's own paths, so the panel
    // can open them.
    app.post("/:id/ask/:threadId/files", async (context) => {
      const thread = readThread(
        context.req.param("id"),
        context.req.param("threadId"),
      );

      const { paths } = askFilesSchema.parse(
        await readBoundedRequestJson(context.req.raw),
      );

      const { cwd, entries } = thread.read();

      const touched = entries.flatMap((entry) =>
        entry.kind === "tool"
          ? `${entry.title} ${entry.input ?? ""}`
              .split(/\s+/)
              .flatMap((token) => parseFileRef(token)?.path ?? [])
          : [],
      );

      const files = resolveFileRefs(
        cwd,
        await checkoutFiles(cwd),
        paths,
        touched,
      );

      return context.json({
        files: [...files].map(([path, file]) => ({ path, file })),
      });
    });

    // Another model or effort for the next answer.
    app.post("/:id/ask/:threadId/choice", async (context) => {
      const thread = readThread(
        context.req.param("id"),
        context.req.param("threadId"),
      );

      const { kind, value } = askChoiceSchema.parse(
        await readBoundedRequestJson(context.req.raw),
      );

      if (thread.read().status !== "idle")
        throw new ReviewInputError(
          "Settings can change once the agent finishes answering.",
          409,
        );

      try {
        await thread.choose(kind, value);
      } catch (error) {
        throw new ReviewInputError(errorMessage(error), 409);
      }

      return context.json({ ok: true });
    });

    // Bypasses permissions from the next answer, or stops.
    app.post("/:id/ask/:threadId/permissions", async (context) => {
      const thread = readThread(
        context.req.param("id"),
        context.req.param("threadId"),
      );

      const { bypass } = askPermitSchema.parse(
        await readBoundedRequestJson(context.req.raw),
      );

      if (thread.read().status !== "idle")
        throw new ReviewInputError(
          "Settings can change once the agent finishes answering.",
          409,
        );

      try {
        await thread.permit(bypass);
      } catch (error) {
        throw new ReviewInputError(errorMessage(error), 409);
      }

      return context.json({ ok: true });
    });

    // Starts a failed agent again, as after signing it back in, and asks
    // again what it did not answer. The state reports how that goes.
    app.post("/:id/ask/:threadId/retry", (context) => {
      const thread = readThread(
        context.req.param("id"),
        context.req.param("threadId"),
      );

      if (thread.read().status !== "failed")
        throw new ReviewInputError(
          "Only a conversation that failed can try again.",
          409,
        );
      void thread.retry();

      return context.json({ ok: true });
    });

    app.post("/:id/ask/:threadId/cancel", async (context) => {
      await readThread(
        context.req.param("id"),
        context.req.param("threadId"),
      ).cancel();

      return context.json({ ok: true });
    });

    // Closing an Ask ends its agent; the conversation stays saved. A tab
    // switched away from or a reload leaves it running, to come back to.
    app.post("/:id/ask/:threadId/close", (context) => {
      readThread(context.req.param("id"), context.req.param("threadId"));
      ask.threads.close(context.req.param("threadId"));

      return context.json({ ok: true });
    });

    // Forgets a saved conversation. The agent keeps its own transcript.
    app.delete("/:id/ask/:threadId", async (context) => {
      const reviewId = context.req.param("id");
      const threadId = context.req.param("threadId");

      if ((await store.askHistory.get(threadId))?.reviewId !== reviewId)
        throw new ReviewInputError("This conversation was not found.", 404);

      if (ask.threads.get(threadId)?.reviewId === reviewId)
        ask.threads.close(threadId);
      await store.askHistory.delete(threadId);

      return context.json({ ok: true });
    });
  }

  app.get("/:id/comments", async (context) => {
    const reviewId = context.req.param("id");

    await readReview(reviewId);

    return context.json({ comments: await store.comments.list(reviewId) });
  });

  app.post("/:id/comments", async (context) => {
    const reviewId = context.req.param("id");
    const snapshot = await readReview(reviewId);

    const input = commentInputSchema.parse(
      await readBoundedRequestJson(context.req.raw),
    );

    return context.json(
      await store.comments.add(reviewId, snapshot.version, {
        ...input,
        author: input.author ?? os.userInfo().username,
      }),
      201,
    );
  });

  app.post("/:id/comments/resolve", async (context) => {
    const reviewId = context.req.param("id");

    await readReview(reviewId);

    const { commentId, resolved } = z
      .strictObject({
        commentId: z.string().min(1),
        resolved: z.boolean().default(true),
      })
      .parse(await readBoundedRequestJson(context.req.raw));

    return context.json({
      comments: await store.comments.setResolved(reviewId, commentId, resolved),
    });
  });

  app.get("/:id/stack", async (context) => {
    const query = readQuerySchemas.get.parse(context.req.query());
    const id = context.req.param("id");
    const snapshot = await readReview(id, query.version);

    if (isShared(id) || !snapshot.pins) return context.json({ layers: [] });
    const layers = await resolveReviewStackLayers(snapshot, await store.list());

    return context.json({ layers });
  });

  app.get("/:id/history", async (context) => {
    const id = context.req.param("id");

    if (!isShared(id)) return context.json(await store.history(id));
    const snapshot = await readReview(id);

    return context.json([
      {
        version: snapshot.version,
        title: snapshot.title,
        createdAt: snapshot.createdAt,
      },
    ]);
  });
  app.get("/:id/inspect", async (context) => {
    const query = inspectQuerySchema.parse(context.req.query());
    const id = context.req.param("id");
    const snapshot = await readReview(id, query.version);

    return context.json(
      query.format === "text"
        ? documentText(snapshot, query.targetId, Boolean(query.full))
        : query.targetId !== undefined
          ? inspectSnapshot(snapshot, query.targetId)
          : query.full
            ? snapshot
            : inspectSnapshot(snapshot),
    );
  });
  app.get("/:id", async (context) => {
    const query = readQuerySchemas.get.parse(context.req.query());

    const snapshot = {
      ...(await readReview(context.req.param("id"), query.version)),
    };

    if (data && query.full) {
      try {
        const pins = await data.sourcePins(snapshot);

        if (pins) snapshot.pins = pins;
      } catch (error) {
        if (!(error instanceof ReviewInputError) || error.status !== 404)
          throw error;
        snapshot.sourceUnavailable = true;
      }
    }

    return context.json(
      query.full ? snapshot : inspectSnapshot(snapshot, query.targetId),
    );
  });

  /** After a lens write: the changed lines still uncategorized at that
   * version, so the author can fill the gaps. A comparison that cannot be
   * read leaves a warning instead of failing the saved write. */
  const lensGaps = async (
    reviewId: string,
    version: number,
    request: Request,
  ): Promise<{ uncategorized?: UncategorizedReport; warnings?: string[] }> => {
    if (!data) return {};

    try {
      return {
        uncategorized: uncategorizedReport(
          await reviewProgress(
            store,
            data,
            await store.read(reviewId, version),
            request.signal,
          ),
        ),
      };
    } catch (error) {
      return {
        warnings: [
          `Uncategorized changes are unavailable: ${errorMessage(error)}`,
        ],
      };
    }
  };

  app.post("/commands", async (context) => {
    const { command: body, open: requestedOpen } = takeCreateOpen(
      await readBoundedRequestJson(context.req.raw),
    );

    const request = await locateRepositories(body, async (path) => {
      // Remote mode registers by remote URL, and only once the caller's
      // GitHub identity proves it can read the repository.
      if (access) {
        const caller = authScope!.getStore()!;
        const remote = access.normalizeRepoPath?.(path);

        if (!remote)
          throw new ReviewInputError(
            "Remote deployments register GitHub repository URLs.",
            400,
          );

        if (!(await access.canReadRepo(caller, remote)))
          throw new ReviewInputError("Repository is not registered.", 404);

        return store.registerRemoteRepository(remote);
      }

      if (!data) throw new ReviewInputError("Repositories are unavailable.");

      if (!existsSync(path))
        throw new ReviewInputError(
          process.env.CODE_ROOT?.trim()
            ? `Repository path ${JSON.stringify(path)} is outside the mounted CODE_ROOT or does not exist in the server. Set CODE_ROOT on the host to a directory containing this repository, then bind-mount it at the same absolute path inside the container.`
            : "Repository path does not exist.",
        );

      return data.register(path);
    });

    const input = commandSchema.parse(request);

    // Commands that name ids directly skip locateRepositories, so the
    // caller's access is checked against each named review and repository.
    if (access) {
      const caller = authScope!.getStore()!;
      const operation = input.operation;

      if ("reviewId" in operation && operation.reviewId)
        await assertRepoAccess(operation.reviewId, caller);

      const namedRepositoryId =
        (operation.type === "create" || operation.type === "set_target"
          ? operation.target?.repositoryId
          : undefined) ??
        (operation.type === "create" ? operation.repositoryId : undefined);

      if (namedRepositoryId) {
        const repoPath = await store
          .repositoryPath(namedRepositoryId)
          .catch(() => undefined);

        if (!repoPath || !(await access.canReadRepo(caller, repoPath)))
          throw new ReviewInputError("Repository is not registered.", 404);
      }

      if (operation.type === "create" && operation.pullRequestUrl) {
        const repoPath = operation.pullRequestUrl.replace(/\/pull\/\d+.*$/, "");

        if (!(await access.canReadRepo(caller, repoPath)))
          throw new ReviewInputError("Repository is not registered.", 404);
      }
    }

    const targetRepositoryId =
      input.operation.type === "create" &&
      input.operation.target?.kind === "worktree"
        ? input.operation.target.repositoryId
        : undefined;

    if (
      targetRepositoryId &&
      !(await store.repositories()).some(({ id }) => id === targetRepositoryId)
    )
      throw new ReviewInputError("Select a registered repository.", 400);

    const command = sharedCommandSchema.safeParse(input);

    if (command.success) {
      refuseDisabledScratchpad(command.data.operation.reviewId);
      await ensureScratchpad(command.data.operation.reviewId);
    }

    if (
      input.operation.type === "create" &&
      input.operation.kind === "scratchpad"
    )
      refuseDisabledScratchpad(SCRATCHPAD_ID);

    if (
      command.success &&
      command.data.operation.reviewId?.startsWith("shared-")
    ) {
      const parsed = commandSchema.parse(input);

      if (shared && parsed.operation.type === "delete") {
        await shared.removeLocal(parsed.operation.reviewId);

        return context.json({
          reviewId: parsed.operation.reviewId,
          version: 0,
          deleted: true,
        });
      }

      if (shared && parsed.operation.type === "attention") {
        await shared.setAttention(
          parsed.operation.reviewId,
          parsed.operation.action,
        );

        return context.json({
          reviewId: parsed.operation.reviewId,
          version: shared.get(parsed.operation.reviewId).snapshot.version,
          attention: true,
        });
      }

      throw new ReviewInputError("Shared reviews are read-only.", 409);
    }

    const result = await store.execute(input);

    if (input.operation.type === "edit" && data && !result.deleted) {
      const { quotes, unquoted } = await anchorQuotes(
        result.version > 0
          ? await store.read(result.reviewId, result.version - 1)
          : undefined,
        await store.read(result.reviewId, result.version),
        async (pins, side, file) => (await data.file(pins, side, file)).text,
      );

      return context.json({
        ...result,
        ...(quotes.length && { quotes }),
        ...(unquoted && { unquotedAnchors: unquoted }),
      });
    }

    if (input.operation.type === "lens_edit") {
      const gaps = await lensGaps(
        result.reviewId,
        result.version,
        context.req.raw,
      );

      return context.json({
        ...result,
        ...gaps,
        ...(gaps.warnings && {
          warnings: [...(result.warnings ?? []), ...gaps.warnings],
        }),
      });
    }

    if (input.operation.type !== "create") return context.json(result);

    // False when an existing review for the same PR came back.
    if (result.created !== false)
      hooks.onReviewCreated?.({
        reviewId: result.reviewId,
        kind: input.operation.kind === "scratchpad" ? "scratchpad" : "review",
        blocks: (await store.read(result.reviewId)).document.length,
        ...reviewRequestOrigin(context.req.raw.headers),
      });

    return context.json({
      ...result,
      review: await store.summary(result.reviewId),
      ...(requestedOpen === false
        ? { opened: false }
        : await openCreated(result.reviewId)),
    });
  });

  return app;
}

const systemErrorSchema = z.object({ code: z.string().regex(/^[A-Z0-9_]+$/) });

/** A system error code such as EACCES, else the error's class; never its message. */
function failureKind(error: Error): string {
  const system = systemErrorSchema.safeParse(error);

  return system.success ? system.data.code : error.name;
}

/**
 * `open` steers presentation, not the saved review, so it stays out of the
 * command. Anything else, including `open` off create, is left for
 * commandSchema to reject.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Request body boundary: commandSchema parses the result.
function takeCreateOpen(body: unknown) {
  const create = z
    .looseObject({
      operation: z.looseObject({
        type: z.literal("create"),
        open: z.boolean().optional(),
      }),
    })
    .safeParse(body);

  if (!create.success) return { command: body };
  const { open, ...operation } = create.data.operation;

  return { command: { ...create.data, operation }, open };
}

/**
 * Agents name a checkout by its path (pathTargetSchema, and repositoryPath on
 * a create from a PR); the store keeps the id it registers as. A command that
 * already names ids is left as it is.
 */
async function locateRepositories(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Request body boundary: commandSchema parses the result.
  body: unknown,
  register: (path: string) => Promise<{ id: string }>,
) {
  const located = z
    .looseObject({
      operation: z.looseObject({
        type: z.enum(["create", "set_target"]),
        target: z.looseObject({ repositoryPath: z.string() }).optional(),
        repositoryPath: z.string().optional(),
      }),
    })
    .safeParse(body);

  if (!located.success) return body;
  const { target, repositoryPath, ...operation } = located.data.operation;

  const byId = async <Named extends { repositoryPath: string }>({
    repositoryPath: path,
    ...rest
  }: Named) => ({ ...rest, repositoryId: (await register(path)).id });

  return {
    ...located.data,
    operation: {
      ...operation,
      ...(target && { target: await byId(target) }),
      ...(repositoryPath && (await byId({ repositoryPath }))),
    },
  };
}

/** Send committed state, coalescing updates when the reader falls behind. */
async function watch<T>(
  read: () => T | Promise<T>,
  subscribe: (notify: () => void) => () => void,
  probe?: () => void | Promise<void>,
) {
  // Return a normal 404 before opening the response.
  if (probe) await probe();
  else await read();

  let stop = () => {};

  let dirty = true;
  let reading = false;
  // A read result that already consumed its marks, held while back-pressured.
  let buffered: string | undefined;
  const encoder = new TextEncoder();

  const send = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (
      buffered &&
      controller.desiredSize !== null &&
      controller.desiredSize > 0
    ) {
      const line = buffered;
      buffered = undefined;

      try {
        controller.enqueue(encoder.encode(line));
      } catch (error) {
        // A review can be deleted while this stream is open. Do not throw into
        // the already-committed writer; close this reader and unsubscribe it.
        stop();
        controller.error(error);

        return;
      }
    }

    if (
      reading ||
      !dirty ||
      buffered ||
      controller.desiredSize === null ||
      controller.desiredSize <= 0
    )
      return;

    dirty = false;
    reading = true;

    void Promise.resolve()
      .then(read)
      .then((value) => {
        reading = false;
        buffered = JSON.stringify(value) + "\n";
        send(controller);
      })
      .catch((error) => {
        // The same close, for a read that fails.
        reading = false;
        stop();
        controller.error(error);
      });
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stop = subscribe(() => {
        dirty = true;
        send(controller);
      });
      send(controller);
    },
    pull: send,
    cancel() {
      stop();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
    },
  });
}
