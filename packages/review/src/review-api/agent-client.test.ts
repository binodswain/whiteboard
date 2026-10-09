import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";

import type { JsonObject } from "@dev.fast/json";
import { detectLocalVcsSync } from "@dev.fast/local-vcs";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { runReviewAgentCli } from "./agent-cli.js";
import * as agentClient from "./agent-client.js";
import { type AuthoringTool, callAuthoringTool } from "./agent-client.js";
import { ReviewApiClient } from "./client.js";
import { createReviewApi } from "./http.js";
import { serveReviewMcp } from "./mcp.js";
import { ReviewStore } from "./store.js";

const store = new ReviewStore(":memory:", {
  validatePins: async () => {},
  validateSource: async () => {},
  validateResource: async () => {},
});

const app = createReviewApi(store);

afterAll(() => store.close());

const client = new ReviewApiClient(
  { serverUrl: "http://review.test", token: "test" },
  async (url, init) => app.request(url.replace("/reviews-api", ""), init),
);

afterEach(async () => {
  vi.unstubAllGlobals();
  // The scratchpad cannot be deleted; every review can.

  for (const { reviewId, kind } of store.list())
    if (kind !== "scratchpad")
      await store.execute({
        operation: { type: "delete", reviewId },
      });
});

/** Catalog entries that are reviews: listing also makes the scratchpad. */
const reviewsOnly = (entries: { kind?: string }[]) =>
  entries.filter((entry) => entry.kind !== "scratchpad");

it("uses host-advertised tools to edit, retry, reject invalid content and inspect saved IDs", async () => {
  const tools = await client.read<AuthoringTool[]>("/authoring");

  const call = (name: string, args: Parameters<typeof callAuthoringTool>[2]) =>
    callAuthoringTool(
      client,
      tools.find((t) => t.name === `review_${name}`)!,
      args,
    );

  const created = (await call("create", {
    title: "Authoring",
    target: {
      kind: "commits",
      repositoryId: "repo",
      base: "base",
      head: "head",
    },
  })) as { reviewId: string };

  const input = {
    reviewId: created.reviewId,
    edit: {
      type: "insert",
      content: {
        type: "sequence",
        title: "Save",
        actors: { agent: "Agent", host: "Host" },
        steps: [
          {
            from: "agent",
            to: "host",
            label: "Save",
            explanation: "Validated before saving.",
          },
        ],
      },
    },
  };

  const result = (await call("edit", input)) as { targetId: string };
  expect(store.read(created.reviewId).version).toBe(1);
  expect(
    await call("get", {
      reviewId: created.reviewId,
      targetId: result.targetId,
      format: "json",
    }),
  ).toMatchObject({ type: "sequence", id: result.targetId });
  await expect(
    call("edit", {
      ...input,
      edit: {
        type: "update",
        targetId: result.targetId,
        changes: { actors: { agent: "Agent" } },
      },
    }),
  ).rejects.toThrow(Error);
  expect(store.read(created.reviewId).version).toBe(1);
  await call("edit", {
    reviewId: created.reviewId,
    edit: {
      type: "update",
      targetId: result.targetId,
      changes: { title: "Saved" },
    },
  });
  expect(
    await call("get", {
      reviewId: created.reviewId,
      full: true,
      format: "json",
    }),
  ).toMatchObject({
    version: 2,
    document: [{ id: result.targetId, title: "Saved" }],
  });
  expect(
    await call("get", {
      reviewId: created.reviewId,
      version: 1,
      full: true,
      format: "json",
    }),
  ).toMatchObject({ version: 1, document: [{ title: "Save" }] });
  const text = await call("get", { reviewId: created.reviewId, full: true });
  expect(text).toContain(`[${result.targetId}] sequence: Saved`);
  expect(text).toContain("Validated before saving.");
  expect(
    await call("get", { reviewId: created.reviewId, version: 1 }),
  ).toContain("sequence: Save");
  // IDs discovered in the reading view still identify the same editable nodes.
  const stepId = String(text).match(/\[(step-\d+)\]/)![1];
  await call("edit", {
    reviewId: created.reviewId,
    edit: {
      type: "update",
      targetId: stepId,
      changes: { explanation: "Updated through the reading view." },
    },
  });
  expect(
    await call("get", { reviewId: created.reviewId, targetId: stepId }),
  ).toContain("Updated through the reading view.");
});

it("connects to WHITEBOARD_URL without a token header and lets it override discovery", async () => {
  const fetchMock = vi.fn<typeof fetch>(async () =>
    Response.json({ ok: true, instanceId: "server" }),
  );

  vi.stubGlobal("fetch", fetchMock);

  const connected = await agentClient.connectReviewInstance(
    {
      WHITEBOARD_URL: "http://localhost:3000",
      DEV_REVIEW_SERVER_DIR: "/missing",
    },
    {},
  );

  expect(connected.client.connection).toEqual({
    serverUrl: "http://localhost:3000",
    token: undefined,
  });
  await connected.client.read("/health");
  const [, request] = fetchMock.mock.calls.at(-1)!;
  expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(
    "http://localhost:3000/reviews-api/health",
  );
  expect(new Headers(request?.headers).has("x-review-token")).toBe(false);
});

it("uses WHITEBOARD_TOKEN when connecting to WHITEBOARD_URL", async () => {
  const fetchMock = vi.fn<typeof fetch>(async () =>
    Response.json({ ok: true, instanceId: "server" }),
  );

  vi.stubGlobal("fetch", fetchMock);

  const connected = await agentClient.connectReviewInstance({
    WHITEBOARD_URL: "http://localhost:3000",
    WHITEBOARD_TOKEN: "secret",
  });

  await connected.client.read("/health");

  const request = fetchMock.mock.calls.at(-1)![1];
  expect(new Headers(request?.headers).get("x-review-token")).toBe("secret");
});

it("probes localhost:3000 when Desktop discovery finds nothing", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) =>
      String(input) === "http://localhost:3000/health"
        ? Response.json({ ok: true, instanceId: "server" })
        : Promise.reject(new Error("unexpected request")),
    ),
  );
  const connected = await agentClient.connectReviewInstance({});
  expect(connected.client.connection.serverUrl).toBe("http://localhost:3000");
});

it("does not accept an unrelated 200 response as localhost Whiteboard health", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => Response.json({ status: "ok" })),
  );

  await expect(agentClient.connectReviewInstance({})).rejects.toThrow(
    /localhost:3000\/health.*docker compose up.*localhost:3000\/setup/i,
  );
});

it("rejects an explicit URL whose 200 health response is not Whiteboard JSON", async () => {
  const fetchMock = vi.fn<typeof fetch>(async () =>
    Response.json({ status: "ok" }),
  );

  vi.stubGlobal("fetch", fetchMock);

  await expect(
    agentClient.connectReviewInstance({
      WHITEBOARD_URL: "http://localhost:3000",
    }),
  ).rejects.toThrow(
    /localhost:3000\/health.*docker compose up.*localhost:3000\/setup/i,
  );
  expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
});

it("defaults a missing target repositoryPath to the process git root", async () => {
  let body: unknown;
  const repositoryPath = detectLocalVcsSync(process.cwd())?.rootPath;

  expect(repositoryPath).toBeDefined();

  const api = new ReviewApiClient(
    { serverUrl: "http://review.test", token: "test" },
    async (_url, init) => {
      body = JSON.parse(String(init?.body));

      return Response.json({ ok: true });
    },
  );

  const tool: AuthoringTool = {
    name: "review_create",
    description: "",
    inputSchema: { type: "object" },
    method: "POST",
    path: "/commands",
    commandType: "create",
  };

  await callAuthoringTool(api, tool, {
    title: "Current repo",
    target: { kind: "worktree" },
  });
  expect(body).toMatchObject({
    operation: {
      target: {
        kind: "worktree",
        repositoryPath,
      },
    },
  });
});

it("preserves an explicit target repositoryPath", async () => {
  let body: unknown;

  const api = new ReviewApiClient(
    { serverUrl: "http://review.test", token: "test" },
    async (_url, init) => {
      body = JSON.parse(String(init?.body));

      return Response.json({ ok: true });
    },
  );

  const tool: AuthoringTool = {
    name: "review_create",
    description: "",
    inputSchema: { type: "object" },
    method: "POST",
    path: "/commands",
    commandType: "create",
  };

  await callAuthoringTool(api, tool, {
    title: "Other repo",
    target: { kind: "worktree", repositoryPath: "/other" },
  });
  expect(body).toMatchObject({
    operation: { target: { repositoryPath: "/other" } },
  });
});

it("leaves scratchpad targets without a repository path", async () => {
  let body: unknown;

  const api = new ReviewApiClient(
    { serverUrl: "http://review.test", token: "test" },
    async (_url, init) => {
      body = JSON.parse(String(init?.body));

      return Response.json({ ok: true });
    },
  );

  await callAuthoringTool(
    api,
    {
      name: "review_create",
      description: "",
      inputSchema: { type: "object" },
      method: "POST",
      path: "/commands",
      commandType: "create",
    },
    {
      title: "Scratchpad",
      target: { kind: "scratchpad" },
    },
  );

  expect(body).toMatchObject({ operation: { target: { kind: "scratchpad" } } });
  expect(body).not.toHaveProperty("operation.target.repositoryPath");
});

it("does not default repositoryPath for a non-create target tool", async () => {
  let body: unknown;

  const api = new ReviewApiClient(
    { serverUrl: "http://review.test", token: "test" },
    async (_url, init) => {
      body = JSON.parse(String(init?.body));

      return Response.json({ ok: true });
    },
  );

  await callAuthoringTool(
    api,
    {
      name: "review_edit",
      description: "",
      inputSchema: { type: "object" },
      method: "POST",
      path: "/commands",
      commandType: "edit",
    },
    {
      target: { kind: "worktree" },
    },
  );

  expect(body).toMatchObject({ operation: { target: { kind: "worktree" } } });
  expect(body).not.toHaveProperty("operation.target.repositoryPath");
});

it("defaults a commits target to the current git root", async () => {
  let body: unknown;
  const repositoryPath = detectLocalVcsSync(process.cwd())?.rootPath;

  const api = new ReviewApiClient(
    { serverUrl: "http://review.test", token: "test" },
    async (_url, init) => {
      body = JSON.parse(String(init?.body));

      return Response.json({ ok: true });
    },
  );

  await callAuthoringTool(
    api,
    {
      name: "review_create",
      description: "",
      inputSchema: { type: "object" },
      method: "POST",
      path: "/commands",
      commandType: "create",
    },
    {
      title: "Commits target",
      target: { kind: "commits", head: "head" },
    },
  );

  expect(body).toMatchObject({
    operation: { target: { kind: "commits", repositoryPath } },
  });
});

it("defaults a set_target worktree to the current git root", async () => {
  let body: unknown;
  const repositoryPath = detectLocalVcsSync(process.cwd())?.rootPath;

  const api = new ReviewApiClient(
    { serverUrl: "http://review.test", token: "test" },
    async (_url, init) => {
      body = JSON.parse(String(init?.body));

      return Response.json({ ok: true });
    },
  );

  await callAuthoringTool(
    api,
    {
      name: "review_set_target",
      description: "",
      inputSchema: { type: "object" },
      method: "POST",
      path: "/commands",
      commandType: "set_target",
    },
    {
      reviewId: "review",
      target: { kind: "worktree" },
    },
  );

  expect(body).toMatchObject({
    operation: { target: { kind: "worktree", repositoryPath } },
  });
});

it("serves MCP framing without stdout diagnostics and returns host errors as tool errors", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const calls: Array<[string, string, boolean, string?]> = [];

  const server = await serveReviewMcp(
    async () => ({ client }),
    stdin,
    stdout,
    undefined,
    false,
    undefined,
    ({ tool, via, ok, errorName }) =>
      void calls.push(errorName ? [tool, via, ok, errorName] : [tool, via, ok]),
  );

  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk;
  });

  const request = async <Params>(
    id: number,
    method: string,
    params: Params,
  ) => {
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await expect
      .poll(() =>
        output
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((reply) => reply.id === id),
      )
      .toBeTruthy();

    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((reply) => reply.id === id);
  };

  try {
    await request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const list = await request(2, "tools/list", {});
    ListToolsResultSchema.parse(list.result);
    // The Anthropic API rejects these at the top level of a tool input schema.
    expect(
      list.result.tools.filter((tool: AuthoringTool) =>
        ["anyOf", "oneOf", "allOf"].some((key) => key in tool.inputSchema),
      ),
    ).toEqual([]);
    // Codex and Claude Code mishandle $ref (openai/codex#13746,
    // anthropics/claude-code#18260).
    expect(
      list.result.tools.filter((tool: AuthoringTool) =>
        JSON.stringify(tool.inputSchema).includes("$ref"),
      ),
    ).toEqual([]);
    expect(
      list.result.tools.find(
        (tool: AuthoringTool) => tool.name === "session_edit",
      ).inputSchema,
    ).toMatchObject({
      type: "object",
      required: ["sessionId", "edit"],
      properties: expect.objectContaining({ activityId: expect.anything() }),
    });

    const error = await request(3, "tools/call", {
      name: "session_get",
      arguments: { sessionId: "missing" },
    });

    expect(error.result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringMatching(/not found/i) }],
    });

    const next = await request(4, "tools/call", {
      name: "session_list",
      arguments: {},
    });

    expect(reviewsOnly(JSON.parse(next.result.content[0].text))).toEqual([]);

    const created = await store.execute({
      operation: {
        type: "create",
        title: "Readable review",
        target: {
          kind: "commits",
          repositoryId: "repo",
          base: "base",
          head: "head",
        },
      },
    });

    const read = await request(5, "tools/call", {
      name: "session_get",
      arguments: { sessionId: created.reviewId },
    });

    expect(read.result.content[0].text.startsWith("# Readable review\n")).toBe(
      true,
    );

    const raw = await request(6, "tools/call", {
      name: "session_get",
      arguments: { sessionId: created.reviewId, full: true, format: "json" },
    });

    expect(JSON.parse(raw.result.content[0].text)).toMatchObject({
      sessionId: created.reviewId,
      document: [],
    });

    await request(7, "tools/call", { name: "my private notes", arguments: {} });

    expect(calls).toEqual([
      ["session_get", "mcp", false, "review_not_found"],
      ["session_list", "mcp", true],
      ["session_get", "mcp", true],
      ["session_get", "mcp", true],
      ["other", "mcp", false, "usage_error"],
    ]);
  } finally {
    await server.close();
  }
});

it("reports each api tool call with its outcome", async () => {
  const connection = vi
    .spyOn(agentClient, "connectReviewInstance")
    .mockResolvedValue({ client, instance: { key: "stable" } });

  const calls: Array<[string, string, boolean, string?]> = [];

  const discard = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });

  const run = (argv: string[]) =>
    runReviewAgentCli({
      argv,
      stdout: discard,
      stderr: discard,
      // Queued a tick late, like a real capture: the command must wait.
      onToolCall: async ({ tool, via, ok, errorName }) => {
        await new Promise((resolve) => setImmediate(resolve));
        calls.push(errorName ? [tool, via, ok, errorName] : [tool, via, ok]);
      },
    });

  try {
    expect(await run(["api", "session_list"])).toBe(0);
    expect(await run(["api", "session_get", '{"sessionId":"missing"}'])).toBe(
      1,
    );
    expect(await run(["api", "no_such_tool"])).toBe(1);
    expect(calls).toEqual([
      ["session_list", "api", true],
      ["session_get", "api", false, "review_not_found"],
    ]);
  } finally {
    connection.mockRestore();
  }
});

it("accepts --url on the api command and overrides state directory selection", async () => {
  let connectedEnv: NodeJS.ProcessEnv | undefined;

  const connection = vi
    .spyOn(agentClient, "connectReviewInstance")
    .mockImplementation(async (env) => {
      connectedEnv = env;

      return { client };
    });

  const discard = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });

  try {
    expect(
      await runReviewAgentCli({
        argv: ["api", "session_list", "--url", "http://localhost:3000"],
        env: { DEV_REVIEW_SERVER_DIR: "/ignored" },
        stdout: discard,
        stderr: discard,
      }),
    ).toBe(0);
    expect(connectedEnv).toMatchObject({
      WHITEBOARD_URL: "http://localhost:3000",
      DEV_REVIEW_SERVER_DIR: "/ignored",
    });
  } finally {
    connection.mockRestore();
  }
});

it("prints the headless session URL for session_open", async () => {
  const headlessApi = createReviewApi(
    store,
    undefined,
    undefined,
    undefined,
    () => ({ desktopAvailable: false, softwareMapEnabled: false }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    (sessionId) =>
      `http://127.0.0.1:3000/r/${encodeURIComponent(sessionId)}#token=test-token`,
  );

  const headlessClient = new ReviewApiClient(
    { serverUrl: "http://review.test", token: "test-token" },
    async (url, init) =>
      headlessApi.request(url.replace("/reviews-api", ""), init),
  );

  const connection = vi
    .spyOn(agentClient, "connectReviewInstance")
    .mockResolvedValue({ client: headlessClient });

  const created = await store.execute({
    operation: {
      type: "create",
      title: "Headless URL",
      target: {
        kind: "commits",
        repositoryId: "repo",
        base: "base",
        head: "head",
      },
    },
  });

  let output = "";

  const stdout = new Writable({
    write(chunk, _encoding, done) {
      output += chunk;
      done();
    },
  });

  try {
    expect(
      await runReviewAgentCli({
        argv: [
          "api",
          "session_open",
          JSON.stringify({ sessionId: created.reviewId }),
        ],
        stdout,
        stderr: stdout,
      }),
    ).toBe(0);
    expect(JSON.parse(output)).toEqual({
      ok: true,
      opened: false,
      url: `http://127.0.0.1:3000/r/${encodeURIComponent(created.reviewId)}#token=test-token`,
    });
  } finally {
    connection.mockRestore();
  }
});

it("hands the parent CLI the release of the Desktop an api call reached", async () => {
  const connection = vi
    .spyOn(agentClient, "connectReviewInstance")
    .mockResolvedValue({
      client,
      instance: { key: "preview", appVersion: "0.1.6-preview.20261002.90" },
    });

  const releases: Array<string | undefined> = [];

  const discard = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });

  try {
    expect(
      await runReviewAgentCli({
        argv: ["api", "session_list"],
        stdout: discard,
        stderr: discard,
        onDesktop: (appVersion) => releases.push(appVersion),
      }),
    ).toBe(0);
    expect(releases).toEqual(["0.1.6-preview.20261002.90"]);
  } finally {
    connection.mockRestore();
  }
});

it("shows CLI help without requiring Desktop or touching review storage", async () => {
  let output = "";

  const stream = new Writable({
    write(chunk, _encoding, done) {
      output += chunk;
      done();
    },
  });

  expect(
    await runReviewAgentCli({
      argv: ["api", "--help"],
      stdin: Readable.from([]),
      stdout: stream,
      stderr: stream,
      env: { DEV_REVIEW_HOME: "/does-not-exist" },
    }),
  ).toBe(0);
  expect(output).toContain("whiteboard api <tool-name>");
});

it("prints readable CLI output by default and raw objects with --json", async () => {
  const connection = vi
    .spyOn(agentClient, "connectReviewInstance")
    .mockResolvedValue({ client });

  const created = await store.execute({
    operation: {
      type: "create",
      title: "CLI reading",
      target: {
        kind: "commits",
        repositoryId: "repo",
        base: "base",
        head: "head",
      },
    },
  });

  try {
    const read = async (flags: string[]) => {
      let output = "";

      const stdout = new Writable({
        write(chunk, _encoding, done) {
          output += chunk;
          done();
        },
      });

      expect(
        await runReviewAgentCli({
          argv: [
            "api",
            "session_get",
            JSON.stringify({ sessionId: created.reviewId, full: true }),
            ...flags,
          ],
          stdout,
          stderr: stdout,
        }),
      ).toBe(0);

      return output;
    };

    expect((await read([])).startsWith("# CLI reading\n")).toBe(true);
    expect(JSON.parse(await read(["--json"]))).toMatchObject({
      sessionId: created.reviewId,
      document: [],
    });
  } finally {
    connection.mockRestore();
  }
});

it("binds existing content through the host-advertised PR tool", async () => {
  const tools = await client.read<AuthoringTool[]>("/authoring");

  const created = await store.execute({
    operation: {
      type: "create",
      title: "PR",
      target: {
        kind: "commits",
        repositoryId: "repo",
        base: "base",
        head: "head",
      },
    },
  });

  await store.execute({
    operation: {
      type: "edit",
      reviewId: created.reviewId,
      edit: {
        type: "insert",
        content: { type: "markdown", markdown: "Keep the authored review" },
      },
    },
  });

  const authored = store.read(created.reviewId).document;

  await callAuthoringTool(
    client,
    tools.find((tool) => tool.name === "review_set_target")!,
    {
      reviewId: created.reviewId,
      target: {
        kind: "commits",
        repositoryId: "repo",
        base: "base",
        head: "head",
      },
      pullRequestUrl: "https://github.com/devdotfast/review/pull/310",
    },
  );
  expect(store.read(created.reviewId).document).toEqual(authored);
  expect(
    store.list().find((review) => review.reviewId === created.reviewId)?.origin,
  ).toEqual({
    pullRequestNumber: 310,
    pullRequestUrl: "https://github.com/devdotfast/review/pull/310",
  });
});

it("tells the server which surface and agent harness made the call", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "agent-origin-"));
  const instanceId = randomUUID();
  const seen: Array<[string | undefined, string | undefined]> = [];

  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");

    if (request.url === "/health") {
      response.end(JSON.stringify({ ok: true, instanceId }));

      return;
    }

    seen.push([
      request.headers["x-review-via"]?.toString(),
      request.headers["x-review-agent"]?.toString(),
    ]);
    response.end("[]");
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = z.object({ port: z.number() }).parse(server.address());
    await mkdir(path.join(stateDir, "review-server"), { recursive: true });
    await writeFile(
      path.join(stateDir, "review-server", "server.json"),
      JSON.stringify({
        version: 1,
        instanceId,
        url: `http://127.0.0.1:${port}`,
        serverPid: process.pid,
        token: "token",
      }),
    );

    const discard = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });

    expect(
      await runReviewAgentCli({
        argv: ["api", "tools"],
        stdout: discard,
        stderr: discard,
        env: { DEV_REVIEW_SERVER_DIR: stateDir, CODEX_THREAD_ID: "thread-1" },
      }),
    ).toBe(0);
    expect(seen).toEqual([["api", "codex"]]);
  } finally {
    server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

it("keeps an MCP session on the instance key it first reached", async () => {
  const keys: (string | undefined)[] = [];

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk;
  });

  const server = await serveReviewMcp(
    async (key) => {
      keys.push(key);

      return { client, instance: { key: "preview" } };
    },
    stdin,
    stdout,
    process.stderr,
    false,
    async (problem) => ({ desktopAvailable: false, problem }),
  );

  const reply = async (id: number, method: string, params: JsonObject) => {
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    let found: { result: { isError?: boolean; content?: { text: string }[] } };
    await expect
      .poll(() => {
        found = output
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((line) => line.id === id);

        return found;
      })
      .toBeTruthy();

    return found!.result;
  };

  try {
    await reply(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    await reply(2, "tools/list", {});

    const result = await reply(3, "tools/call", {
      name: "session_list",
      arguments: {},
    });

    // Every connect after the first names the latched key, so a Desktop that
    // restarts under the same key is followed and another key is never chosen.
    expect(keys).toEqual([undefined, "preview"]);
    expect(result.isError).toBeFalsy();
  } finally {
    await server.close();
  }
});

it("names the agent from the MCP handshake, falling back to the session environment", async () => {
  // The header names the agent on reviews the session creates; the call names it on tool events.
  const headerAgents: (string | undefined)[] = [];
  const callAgents: (string | undefined)[] = [];

  const connection = vi
    .spyOn(agentClient, "connectReviewInstance")
    .mockImplementation(async (_env, headers) => {
      headerAgents.push(headers?.["x-review-agent"]);

      return { client };
    });

  const session = async (clientName: string, env: NodeJS.ProcessEnv) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk;
    });

    await runReviewAgentCli({
      argv: ["mcp"],
      env,
      stdin,
      stdout,
      stderr: new PassThrough(),
      onToolCall: ({ agentKind }) => void callAgents.push(agentKind),
    });

    const reply = async (id: number, method: string, params: JsonObject) => {
      stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
      await expect
        .poll(() =>
          output
            .split("\n")
            .filter(Boolean)
            .some((line) => JSON.parse(line).id === id),
        )
        .toBe(true);
    };

    await reply(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: clientName, version: "1" },
    });
    await reply(2, "tools/call", { name: "session_list", arguments: {} });
    stdin.end();
  };

  try {
    // Codex strips CODEX_* from the server's environment; its handshake says who it is.
    await session("codex-mcp-client", {});
    await session("some-editor", { CLAUDE_CODE_SESSION_ID: "session" });
    expect(headerAgents).toEqual(["codex", "claude"]);
    expect(callAgents).toEqual(["codex", "claude"]);
  } finally {
    connection.mockRestore();
  }
});
