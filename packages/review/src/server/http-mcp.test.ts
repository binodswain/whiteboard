import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JsonObject } from "@dev.fast/json";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openReviewProfile } from "@review/review-api/profile.js";
import type { ReviewStore } from "@review/review-api/store.js";
import type { Hono } from "hono";
import { afterEach, beforeEach, expect, it } from "vitest";

import { GlobalReviewDesktopVerbRelay } from "./global-verb-relay.js";
import { createHttpMcpApp } from "./http-mcp.js";
import { createWhiteboardCore } from "./review-server-core.js";

let root: string;

const stores: ReviewStore[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "http-mcp-"));
});

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await rm(root, { recursive: true, force: true });
});

async function repository() {
  const directory = path.join(root, "repo");
  await mkdir(directory);

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();

  git("init", "-q");
  git("config", "user.name", "Review Test");
  git("config", "user.email", "review-test@example.invalid");
  await writeFile(
    path.join(directory, "example.ts"),
    "export const value = 1;\n",
  );
  git("add", ".");
  git("commit", "-qm", "base");
  await writeFile(
    path.join(directory, "example.ts"),
    "export const value = 2;\n",
  );
  git("commit", "-qam", "head");

  return directory;
}

/** One replica: its own process state over the store every replica shares. */
async function replica(home: string): Promise<Hono> {
  const profile = await openReviewProfile(home, { manageWorkspaces: false });
  stores.push(profile.store);

  const core = createWhiteboardCore({
    profile,
    relay: new GlobalReviewDesktopVerbRelay(),
    token: "replica-test-token-000000000000000000",
    instanceId: randomUUID(),
    scratchpad: () => false,
    status: () => ({ key: "headless", home }),
  });

  return createHttpMcpApp({
    api: core.api,
    scratchpad: () => false,
    stateless: true,
  });
}

it("completes a create, author and read flow alternating between two stateless replicas", async () => {
  const repo = await repository();
  const home = path.join(root, "home");
  const replicas = [await replica(home), await replica(home)];
  const served = [0, 0];
  let next = 0;

  // A round-robin load balancer with no sticky sessions.
  const balancer = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const index = next++ % replicas.length;

    served[index]++;

    return replicas[index]!.fetch(new Request(input, init));
  }) as typeof fetch;

  const client = new Client({ name: "stateless-test", version: "1.0.0" });

  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://whiteboard.test/"), {
      fetch: balancer,
    }),
  );

  const call = async (name: string, args: JsonObject) => {
    const result = await client.callTool({ name, arguments: args });
    const text = JSON.stringify(result);

    expect(result.isError).not.toBe(true);
    expect(text).not.toContain("session not found");

    return String((result.content as { text: string }[])[0]!.text);
  };

  const { sessionId } = JSON.parse(
    await call("session_create", {
      title: "Stateless review",
      target: { kind: "worktree", repositoryPath: repo },
      open: false,
    }),
  ) as { sessionId: string };

  const { activityId } = JSON.parse(
    await call("session_activity_begin", {
      sessionId,
      focus: { description: "Writing the summary" },
    }),
  ) as { activityId: string };

  await call("session_edit", {
    sessionId,
    activityId,
    edit: {
      type: "insert",
      content: { type: "markdown", markdown: "Served by any replica." },
    },
  });
  await call("session_activity_end", { sessionId, activityId });

  const read = await call("session_get", { sessionId });

  expect(read).toContain("Served by any replica.");
  expect(served[0]).toBeGreaterThan(0);
  expect(served[1]).toBeGreaterThan(0);

  await client.close();
}, 30_000);
