import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { launchAskAgent } from "@review/ask/agents.js";
import type { AskAgentId } from "@review/ask/thread-state.js";
import type { AskMcpServers } from "@review/ask/thread.js";
import { AskThreads } from "@review/ask/threads.js";

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
  signal?: AbortSignal;
  pollMs?: number;
  onStatus?: (message: string) => void;
}

class WhiteboardHttpError extends Error {
  constructor(readonly status: number) {
    super(`Whiteboard returned HTTP ${status}.`);
  }
}

const ASK_LEASE_MS = 2 * 60_000;

/** Polls, claims and runs one hosted ask at a time. The lease is owned by the
 * connector process, so a crash leaves the ask reclaimable after expiry. */
export async function runAskConnector(
  options: ConnectorOptions,
): Promise<void> {
  const server = options.server.replace(/\/$/, "");
  const runnerId = randomUUID();

  const mcpServers: AskMcpServers = () => [
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
      env: options.token
        ? [{ name: "WHITEBOARD_TOKEN", value: options.token }]
        : [],
    },
  ];

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
    const { asks } = await request<{ asks: PendingAsk[] }>("/asks/pending");
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

    const claimed = await request<{ ask: PendingAsk }>(
      `/asks/${encodeURIComponent(pending.id)}/claim`,
      {
        method: "POST",
        body: JSON.stringify({ runnerId }),
      },
    ).catch(() => undefined);

    if (!claimed) continue;
    options.onStatus?.(`Running ask ${pending.id}.`);

    const threads = new AskThreads(launchAskAgent, { mcpServers });

    const thread = threads.open({
      id: randomUUID(),
      reviewId: pending.reviewId,
      agent: options.agent,
      cwd: process.cwd(),
      head: "hosted",
      selection: { title: "Hosted Whiteboard review" },
      context:
        `You are connected to a hosted Whiteboard review. Its sessionId is "${pending.reviewId}". ` +
        "Call session_get and session_get_instructions before authoring. Use the Whiteboard MCP tools to draw the requested diagram in this review. Do not edit local files.",
      question: { text: pending.prompt },
    });

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
    }
  }
}
