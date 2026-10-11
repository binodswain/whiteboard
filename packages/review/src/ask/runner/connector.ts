import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  type AskAgentLauncher,
  type AskHostedLaunch,
  hostedAgentProblem,
  launchAskAgent,
} from "@review/ask/agents.js";
import type { AskKind } from "@review/ask/runner/queue.js";
import type { AskAgentId } from "@review/ask/thread-state.js";
import type { AskMcpServers } from "@review/ask/thread.js";
import { AskThreads } from "@review/ask/threads.js";
import { z } from "zod";

import { writePullRequestContext } from "./workdir.js";

interface PendingAsk {
  id: string;
  reviewId: string;
  prompt: string;
}

interface ConnectorOptions {
  server: string;
  token?: string;
  agent: AskAgentId;
  cliPath: string;
  /** Takes only asks of this kind. `pr-review` also runs the agent
   * unattended: locked down, keys only, in an empty working directory. */
  kind?: AskKind;
  /** The model a `pr-review` run uses, from the operator's settings. */
  hosted?: AskHostedLaunch;
  /** Stops after one ask, so a supervisor starts the next run clean. */
  once?: boolean;
  /** Fails an ask whose agent has not finished in this long. */
  maxRuntimeMs?: number;
  signal?: AbortSignal;
  pollMs?: number;
  onStatus?: (message: string) => void;
  /** Starts the agent, and checks it can run unattended; tests replace them. */
  launch?: AskAgentLauncher;
  preflight?: typeof hostedAgentProblem;
}

class WhiteboardHttpError extends Error {
  constructor(readonly status: number) {
    super(`Whiteboard returned HTTP ${status}.`);
  }
}

const ASK_LEASE_MS = 2 * 60_000;

/** The reviewer settings a server sends with a pull request ask. */
const claimedAgentSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  env: z.record(z.string(), z.string()),
});

type ClaimedAgent = z.infer<typeof claimedAgentSchema>;

/** Polls, claims and runs one hosted ask at a time. The lease is owned by the
 * connector process, so a crash leaves the ask reclaimable after expiry. */
export async function runAskConnector(
  options: ConnectorOptions,
): Promise<void> {
  const server = options.server.replace(/\/$/, "");
  const runnerId = randomUUID();

  const unattended = options.kind === "pr-review";

  if (unattended) {
    const problem = await (options.preflight ?? hostedAgentProblem)(
      options.agent,
      options.hosted,
      process.env,
      { keys: false },
    );

    if (problem) throw new Error(`Cannot review pull requests: ${problem}`);
  }

  // The agent gets the ask's own token, bound to its one review; the
  // connector's token, which can claim any ask, stays here.
  const mcpServers =
    (token: string | undefined): AskMcpServers =>
    () => [
      {
        name: "whiteboard",
        command: process.execPath,
        args: [
          ...(options.cliPath.endsWith(".ts") ? ["--import", "tsx"] : []),
          options.cliPath,
          "mcp",
          "--url",
          server,
        ],
        env: token ? [{ name: "WHITEBOARD_TOKEN", value: token }] : [],
      },
    ];

  const launch = options.launch ?? launchAskAgent;

  // The server's reviewer settings, when an admin stored them, pick the
  // provider, model and key over the runner's own.
  const launcher =
    (agent?: ClaimedAgent): AskAgentLauncher =>
    (id, cwd, launchOptions) =>
      launch(id, cwd, {
        ...launchOptions,
        ...(unattended && {
          hosted: {
            ...options.hosted,
            ...(agent?.provider && { provider: agent.provider }),
            ...(agent?.model && { model: agent.model }),
            ...(agent && { env: agent.env }),
          },
        }),
      });

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const headers = new Headers(init?.headers);

    if (options.token) headers.set("x-review-token", options.token);

    if (init?.body) headers.set("content-type", "application/json");

    const response = await fetch(`${server}/reviews-api${path}`, {
      ...init,
      headers,
      signal: options.signal,
    });

    if (!response.ok) throw new WhiteboardHttpError(response.status);

    // SAFETY: callers validate each response shape through the queue protocol.
    return (await response.json()) as T;
  };

  options.onStatus?.(`Connected to ${server}; waiting for asks.`);

  while (!options.signal?.aborted) {
    const { asks } = await request<{ asks: PendingAsk[] }>(
      options.kind
        ? `/asks/pending?kind=${encodeURIComponent(options.kind)}`
        : "/asks/pending",
    );

    const pending = asks[0];

    if (!pending) {
      try {
        await delay(options.pollMs ?? 2000, undefined, {
          signal: options.signal,
        });
      } catch (error) {
        if (options.signal?.aborted) return;
        throw error;
      }

      continue;
    }

    const claimed = await request<{
      ask: PendingAsk;
      token?: string;
      agent?: unknown;
    }>(`/asks/${encodeURIComponent(pending.id)}/claim`, {
      method: "POST",
      body: JSON.stringify({ runnerId }),
    }).catch(() => undefined);

    if (!claimed) continue;
    options.onStatus?.(`Running ask ${pending.id}.`);

    if (unattended && !claimed.token) {
      await request(`/asks/${encodeURIComponent(pending.id)}/fail`, {
        method: "POST",
        body: JSON.stringify({
          runnerId,
          error: "The server issued no per-ask token; update it.",
        }),
      }).catch(() => {});

      if (options.once) return;
      continue;
    }

    const agent = claimedAgentSchema.safeParse(claimed.agent);

    const threads = new AskThreads(launcher(agent.data), {
      mcpServers: mcpServers(claimed.token ?? options.token),
    });

    // An unattended agent starts in an empty directory of its own, never
    // the runner's working directory.
    const workdir = unattended
      ? await mkdtemp(path.join(tmpdir(), "whiteboard-ask-"))
      : undefined;

    if (workdir && claimed.token) {
      const askToken = claimed.token;

      // Best effort: without these files the agent still reads the review
      // through its MCP tools.
      try {
        await writePullRequestContext(
          workdir,
          pending.reviewId,
          async (route, schema) => {
            const response = await fetch(`${server}/reviews-api${route}`, {
              headers: { "x-review-token": askToken },
              signal: options.signal,
            });

            if (!response.ok) throw new WhiteboardHttpError(response.status);

            return schema.parse(await response.json());
          },
        );
      } catch (error) {
        options.onStatus?.(
          `Could not copy the pull request into the workdir: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const thread = threads.open({
      id: randomUUID(),
      reviewId: pending.reviewId,
      agent: options.agent,
      cwd: workdir ?? process.cwd(),
      head: "hosted",
      selection: { title: "Hosted Whiteboard review" },
      context:
        `You are connected to a hosted Whiteboard review. Its sessionId is "${pending.reviewId}". ` +
        "Call session_get and session_get_instructions before authoring. Use the Whiteboard MCP tools to do the requested work in this review, such as drawing a diagram or adding a comment. Do not edit local files." +
        (workdir
          ? " The working directory holds the pull request: PR_DIFF.patch, CHANGED_FILES.txt, and changed files' head contents under head/."
          : ""),
      question: { text: pending.prompt },
    });

    const deadline = options.maxRuntimeMs
      ? Date.now() + options.maxRuntimeMs
      : Infinity;

    let ownershipLost = false;
    let nextHeartbeat = Date.now() + ASK_LEASE_MS / 3;

    try {
      for (;;) {
        if (Date.now() >= nextHeartbeat) {
          try {
            await request(`/asks/${encodeURIComponent(pending.id)}/heartbeat`, {
              method: "POST",
              body: JSON.stringify({ runnerId }),
            });
            nextHeartbeat = Date.now() + ASK_LEASE_MS / 3;
          } catch (error) {
            if (!(error instanceof WhiteboardHttpError) || error.status !== 409)
              throw error;

            ownershipLost = true;
            thread.close();
          }
        }

        if (ownershipLost) throw new Error("Ask lease was lost.");

        if (Date.now() >= deadline)
          throw new Error("The agent ran past its time limit.");
        const status = thread.read().status;

        if (status === "idle") break;

        if (status === "failed")
          throw new Error(thread.read().error ?? "The agent failed.");

        if (status === "waiting")
          throw new Error(
            "The agent needs an interactive permission decision; this connector cannot answer it.",
          );
        await delay(500, undefined, { signal: options.signal });
      }

      await request(`/asks/${encodeURIComponent(pending.id)}/complete`, {
        method: "POST",
        body: JSON.stringify({ runnerId, resultRefs: [] }),
      });
    } catch (error) {
      if (!options.signal?.aborted)
        await request(`/asks/${encodeURIComponent(pending.id)}/fail`, {
          method: "POST",
          body: JSON.stringify({
            runnerId,
            error: error instanceof Error ? error.message : String(error),
          }),
        }).catch(() => {});
    } finally {
      await threads.closeAll();

      if (workdir) await rm(workdir, { recursive: true, force: true });
    }

    if (options.once) return;
  }
}
