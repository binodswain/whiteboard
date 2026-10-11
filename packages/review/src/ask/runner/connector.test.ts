import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import type { McpServer } from "@agentclientprotocol/sdk";
import { serve } from "@hono/node-server";
import { type AskAgentLauncher, hostedAgentEnv } from "@review/ask/agents.js";
import { createReviewApi } from "@review/review-api/http.js";
import { ReviewStore } from "@review/review-api/store.js";
import {
  loadDeploymentConfig,
  publicDeploymentConfig,
} from "@review/server/deployment-config.js";
import { GlobalReviewDesktopVerbRelay } from "@review/server/global-verb-relay.js";
import { createReviewServerApp } from "@review/server/review-server-core.js";
import { afterEach, describe, expect, it } from "vitest";

import { runAskConnector } from "./connector.js";

const SERVER_TOKEN = `server-${"t".repeat(40)}`;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function hostedServer() {
  const dir = mkdtempSync(path.join(tmpdir(), "ask-connector-"));

  const store = await ReviewStore.open(path.join(dir, "review.db"), {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });

  const app = createReviewServerApp({
    token: SERVER_TOKEN,
    instanceId: "test-instance",
    serverId: "test-server",
    relay: new GlobalReviewDesktopVerbRelay(),
    deployment: publicDeploymentConfig(loadDeploymentConfig({})),
    askToken: (token) => store.askQueue.authenticateToken(token),
  });

  app.route("/reviews-api", createReviewApi(store));

  const server = serve({ fetch: app.fetch, port: 0 });

  await new Promise<void>((resolve) => server.once("listening", resolve));

  cleanups.push(async () => {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const { reviewId } = await store.execute({
    operation: {
      type: "create",
      title: "Example",
      target: { kind: "commits", repositoryId: "repo", base: "b", head: "h" },
    },
  });

  return {
    store,
    reviewId,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

describe("pull request ask connector", () => {
  it("runs one pull request ask locked down, with only that ask's token", async () => {
    const { store, reviewId, url } = await hostedServer();

    const interactive = await store.askQueue.create({
      reviewId,
      prompt: "A person's question",
      createdBy: "board",
    });

    const prAsk = await store.askQueue.create({
      reviewId,
      kind: "pr-review",
      prompt: "Summarize",
      createdBy: "github-app:1",
    });

    const launches: {
      cwd: string;
      hosted: unknown;
      servers: McpServer[];
    }[] = [];

    const launch: AskAgentLauncher = async (_agent, cwd, options) => {
      launches.push({
        cwd,
        hosted: options?.hosted,
        servers: options?.mcpServers ?? [],
      });
      throw new Error("stub agent cannot start");
    };

    await runAskConnector({
      server: url,
      token: SERVER_TOKEN,
      agent: "pi",
      cliPath: "/unused/whiteboard.js",
      kind: "pr-review",
      hosted: { model: "example-model" },
      once: true,
      pollMs: 10,
      launch,
      preflight: async () => undefined,
    });

    expect(launches).toHaveLength(1);
    const [run] = launches;
    const token = (run.servers[0] as { env: { value: string }[] }).env[0].value;

    expect(token).toMatch(/^wba_/);
    expect(run.hosted).toEqual({ model: "example-model" });
    expect(run.cwd).not.toBe(process.cwd());
    expect(existsSync(run.cwd)).toBe(false);

    expect(await store.askQueue.get(prAsk)).toMatchObject({ status: "failed" });
    expect(await store.askQueue.get(interactive)).toMatchObject({
      status: "pending",
    });
    // The ask is over, so its token no longer opens anything.
    expect(await store.askQueue.authenticateToken(token)).toBeUndefined();
  });

  it("refuses to start when the agent cannot run unattended", async () => {
    await expect(
      runAskConnector({
        server: "http://127.0.0.1:1",
        agent: "claude",
        cliPath: "/unused/whiteboard.js",
        kind: "pr-review",
        once: true,
      }),
    ).rejects.toThrow(/no locked-down mode/);
  });
});

describe("unattended agent environment", () => {
  it("keeps provider keys and drops the runner's other secrets", () => {
    expect(
      hostedAgentEnv(
        {
          keyEnv: ["ANTHROPIC_API_KEY"],
          lockdownArgs: [],
          modelArgs: () => [],
        },
        {
          PATH: "/usr/bin",
          ANTHROPIC_API_KEY: "provider-key",
          WHITEBOARD_TOKEN: "operator-token",
          WHITEBOARD_GITHUB_APP_PRIVATE_KEY: "app-key",
        },
      ),
    ).toEqual({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "provider-key" });
  });
});
