import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  type JsonValue,
  REVIEW_CLIENT_HEADER,
  REVIEW_CLIENT_REMOTE,
  parseReviewDesktopVerbFrame,
} from "@dev.fast/review-protocol";
import { shellQuote } from "@dev.fast/trace-core";
import type { AskAgentStatus } from "@review/ask/agents.js";
import {
  type AskThreadState,
  type AskWatchLine,
  applyAskChange,
  askWatchLineSchema,
} from "@review/ask/thread-state.js";
import { runReviewCli } from "@review/cli-runner.js";
import {
  connectReviewApi,
  connectReviewInstance,
} from "@review/review-api/agent-client.js";
import { ReviewApiClient } from "@review/review-api/client.js";
import type { Pins } from "@review/review-api/document.js";
import { createReviewApi } from "@review/review-api/http.js";
import { serveReviewMcp } from "@review/review-api/mcp.js";
import { openReviewProfile } from "@review/review-api/profile.js";
import type { Result, Snapshot } from "@review/review-api/store.js";
import { writeScratchpadEnabled } from "@review/review-preferences.js";
import { ReviewTelemetry } from "@review/review-telemetry.js";
import {
  type ReviewServerDiscovery,
  headlessServerLockPath,
  readReviewServerDiscovery,
  reviewServerDiscoveryPath,
  reviewServerIsHealthy,
} from "@review/server-discovery.js";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { createGlobalReviewServer } from "./desktop-server.js";
import { headlessAskTools, runHeadlessServer } from "./headless-host.js";

let root: string;

const stops: (() => Promise<void>)[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "review-headless-"));
  vi.stubEnv("DEV_REVIEW_HOME", root);
  vi.stubEnv("DEV_FAST_REVIEW_TELEMETRY_DISABLED", "1");
});

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function start(
  stateDir = path.join(root, "server"),
  softwareMapEnabled = false,
  host?: string,
  ask?: boolean,
) {
  const controller = new AbortController();
  const ready = Promise.withResolvers<ReviewServerDiscovery>();

  const running = runHeadlessServer({
    stateDir,
    host,
    softwareMapEnabled,
    ask,
    signal: controller.signal,
    onReady: ready.resolve,
  });

  const stop = async () => {
    controller.abort();
    await running;
  };

  stops.push(stop);

  const discovery = await Promise.race([
    ready.promise,
    running.then(() => {
      throw new Error("Server exited before readiness");
    }),
  ]);

  const env = { ...process.env, DEV_REVIEW_SERVER_DIR: stateDir };
  const client = await connectReviewApi(env);

  return { client, discovery, env, stateDir, stop };
}

/** The stable id, which /health gives only to a caller with the token. */
async function serverIdOf(discovery: { url: string; token: string }) {
  const response = await fetch(`${discovery.url}/health`, {
    headers: { "x-review-token": discovery.token },
  });

  return (await response.json()).serverId;
}

async function repository() {
  const directory = path.join(root, "repo");
  await mkdir(directory);

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
    }).trim();

  git("init", "-q");
  git("config", "user.name", "Review Test");
  git("config", "user.email", "review-test@example.invalid");
  await writeFile(
    path.join(directory, "example.ts"),
    "export const value = 1;\n",
  );
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  await writeFile(
    path.join(directory, "example.ts"),
    "export const value = 2;\n",
  );
  git("commit", "-qam", "head");

  return { directory, base, head: git("rev-parse", "HEAD") };
}

async function cli(argv: string[], env: NodeJS.ProcessEnv) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  let output = "",
    errors = "";

  stdout.on("data", (chunk) => {
    output += chunk;
  });
  stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const exitCode = await runReviewCli({ argv, env, stdout, stderr });

  return { exitCode, output, errors };
}

it("shares review identity, resources, sessions and live changes with Desktop in one profile", async () => {
  const repo = await repository();
  const server = await start(root);
  const local = await openReviewProfile(root, { manageWorkspaces: true });
  const opened: string[] = [];

  const app = createReviewApi(local.store, local.data, async ({ reviewId }) => {
    opened.push(reviewId);

    return { softwareMapEnabled: false };
  });

  const desktop = new ReviewApiClient(
    { serverUrl: "http://desktop.test", token: "test" },
    async (url, init) => app.request(url.replace("/reviews-api", ""), init),
  );

  const abort = new AbortController();
  const catalog = desktop.watch(null, abort.signal);
  let reviewStream: ReturnType<ReviewApiClient["watch"]> | undefined;

  try {
    // The scratchpad is off by default, so there is nothing to list yet.
    expect((await catalog.next()).value).toEqual([]);

    const registered = await server.client.post<{ id: string }>(
      "/repositories",
      { path: repo.directory },
    );

    const pins = {
      repositoryId: registered.id,
      base: repo.base,
      head: repo.head,
    };

    const created = await server.client.post<Result>("/commands", {
      operation: {
        type: "create",
        title: "Shared review",
        target: { kind: "commits", ...pins },
      },
    });

    // Catalog refreshes can also report repository registration before creation.
    for await (const value of catalog) {
      if (
        Array.isArray(value) &&
        value.some((item) => item.reviewId === created.reviewId)
      )
        break;
    }

    reviewStream = desktop.watch(created.reviewId, abort.signal);
    expect((await reviewStream.next()).value).toMatchObject({
      reviewId: created.reviewId,
      version: 0,
    });

    const { activityId } = await server.client.post<{ activityId: string }>(
      `/${created.reviewId}/activity/begin`,
      {},
    );

    for (;;) {
      const value = (await reviewStream.next()).value;

      if (
        value &&
        !Array.isArray(value) &&
        "activity" in value &&
        value.activity?.workingCount === 1
      )
        break;
    }

    const traceId = randomUUID();
    await server.client.post("/resources", {
      id: traceId,
      repositoryId: registered.id,
      kind: "trace",
      trace: {
        label: "Evidence",
        events: [{ id: "answer", role: "assistant", text: "Shared bytes" }],
      },
    });
    expect(
      await desktop.read(`/${created.reviewId}/resources/${traceId}`),
    ).toMatchObject({
      label: "Evidence",
    });
    await server.client.post("/commands", {
      operation: {
        type: "edit",
        reviewId: created.reviewId,
        activityId,
        edit: {
          type: "insert",
          content: {
            type: "trace_quote",
            traceId,
            eventId: "answer",
            text: "Shared bytes",
          },
        },
      },
    });

    for (;;) {
      const value = (await reviewStream.next()).value;

      if (
        value &&
        !Array.isArray(value) &&
        "version" in value &&
        value.version === 1
      )
        break;
    }

    await desktop.post(`/${created.reviewId}/open`, {});
    expect(opened).toEqual([created.reviewId]);
    expect(
      (await desktop.read<Snapshot[]>(""))
        .map((item) => item.reviewId)
        .filter((id) => id !== "scratchpad"),
    ).toEqual([created.reviewId]);
    await server.client.post(`/${created.reviewId}/activity/end`, {
      activityId,
    });
    await desktop.post("/commands", {
      operation: {
        type: "rename",
        reviewId: created.reviewId,
        title: "Changed in Desktop",
      },
    });
    expect(
      await server.client.read(`/${created.reviewId}?full=true`),
    ).toMatchObject({ title: "Changed in Desktop", version: 2 });
    await server.client.post("/commands", {
      operation: { type: "delete", reviewId: created.reviewId },
    });
    await expect(async () => {
      for await (const _value of reviewStream!) {
      }
    }).rejects.toThrow(/not found/i);
  } finally {
    abort.abort();
    await local.data.close();
    await local.store.close();
  }
});

it("authors through CLI and MCP without Desktop and retains source, unfinished sections and resources across restart", async () => {
  const repo = await repository();
  const server = await start();
  const client = server.client;

  const registered = await client.post<{ id: string }>("/repositories", {
    path: repo.directory,
  });

  const pins: Pins = {
    repositoryId: registered.id,
    base: repo.base,
    head: repo.head,
  };

  const created = await cli(
    [
      "--state-dir",
      server.stateDir,
      "api",
      "session_create",
      JSON.stringify({
        title: "CI review",
        target: {
          kind: "commits",
          repositoryPath: repo.directory,
          base: repo.base,
          head: repo.head,
        },
      }),
    ],
    process.env,
  );

  expect(created).toMatchObject({ exitCode: 0, errors: "" });

  const { sessionId: reviewId } = z
    .object({ sessionId: z.string() })
    .parse(JSON.parse(created.output));

  await client.post("/commands", {
    operation: {
      type: "edit",
      reviewId,
      edit: {
        type: "insert",
        content: {
          type: "section",
          title: "Work in progress",
          children: [],
        },
      },
    },
  });
  const imageId = randomUUID();

  const image = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();

  await client.post("/resources", {
    id: imageId,
    repositoryId: registered.id,
    kind: "image",
    base64: image.toString("base64"),
  });
  await client.post("/commands", {
    operation: {
      type: "edit",
      reviewId,
      edit: {
        type: "insert",
        content: {
          type: "image",
          assetId: imageId,
          alt: "Retained image",
        },
      },
    },
  });
  const traceId = randomUUID();
  await client.post("/resources", {
    id: traceId,
    repositoryId: registered.id,
    kind: "trace",
    trace: {
      label: "CI author",
      events: [{ id: "one", role: "assistant", text: "Checked the source" }],
    },
  });
  // Existing maps can be uploaded even with generation disabled.
  const mapId = randomUUID();
  await client.post("/resources", {
    id: mapId,
    repositoryId: registered.id,
    kind: "map",
    pins,
    side: "head",
    model: {
      systems: {
        app: {
          containers: {
            api: {
              components: {
                value: {
                  codeElements: {
                    value: {
                      sourceRanges: [
                        { file: "example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  await expect(
    client.post("/commands", {
      operation: {
        type: "edit",
        reviewId,
        edit: {
          type: "insert",
          content: {
            type: "code_peek",
            source: "head/missing.ts#L1",
          },
        },
      },
    }),
  ).rejects.toThrow(/unavailable at the pinned commit/i);
  expect(await client.read<Snapshot>(`/${reviewId}?full=true`)).toMatchObject({
    version: 2,
  });
  await server.stop();
  expect(await readReviewServerDiscovery(server.stateDir)).toBeNull();

  const restarted = await start(server.stateDir);
  expect(
    await restarted.client.read<Snapshot>(`/${reviewId}?full=true`),
  ).toMatchObject({
    reviewId,
    pins,
    document: [{ title: "Work in progress" }, { assetId: imageId }],
  });

  const retained = await restarted.client.response(
    `/${reviewId}/resources/${imageId}`,
  );

  expect(Buffer.from(await retained.arrayBuffer())).toEqual(image);
  expect(
    (await restarted.client.response(`/${reviewId}/resources/${traceId}`))
      .status,
  ).toBe(200);
  expect(
    (await restarted.client.response(`/${reviewId}/resources/${mapId}`)).status,
  ).toBe(200);

  const file = await restarted.client.read<{ text: string }>(
    `/${reviewId}/file?side=head&file=example.ts`,
  );

  expect(file.text).toBe("export const value = 2;\n");

  const stdin = new PassThrough(),
    stdout = new PassThrough();

  const mcp = await serveReviewMcp(
    () => connectReviewInstance(restarted.env),
    stdin,
    stdout,
  );

  const replies: {
    id: number;
    result: { content?: { text: string }[]; isError?: boolean };
  }[] = [];

  let buffer = "";
  stdout.on("data", (chunk) => {
    buffer += chunk;
    let end: number;

    while ((end = buffer.indexOf("\n")) >= 0) {
      replies.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });

  try {
    stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "CI", version: "1" },
        },
      }) + "\n",
    );
    await expect.poll(() => replies.some((reply) => reply.id === 1)).toBe(true);
    stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "session_get",
          arguments: { sessionId: reviewId, full: true, format: "json" },
        },
      }) + "\n",
    );
    await expect
      .poll(() => replies.find((reply) => reply.id === 2))
      .toBeTruthy();
    const result = replies.find((reply) => reply.id === 2)!.result;
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content![0].text)).toMatchObject({
      sessionId: reviewId,
      version: 2,
    });
  } finally {
    await mcp.close();
  }
});

it("authenticates clients, reports capabilities and readiness without exposing the token, and diagnoses unavailable commits", async () => {
  const server = await start(undefined, true);
  expect(await reviewServerIsHealthy(server.discovery)).toBe(true);
  expect((await fetch(`${server.discovery.url}/reviews-api`)).status).toBe(401);
  expect(await server.client.read("/capabilities")).toMatchObject({
    desktopAvailable: false,
    softwareMapEnabled: true,
  });

  const status = await cli(
    ["--state-dir", server.stateDir, "server", "status", "--json"],
    process.env,
  );

  expect(status).toMatchObject({ exitCode: 0, errors: "" });
  expect(JSON.parse(status.output)).toMatchObject({
    event: "server.status",
    ready: true,
    version: expect.any(String),
    serverId: await serverIdOf(server.discovery),
  });
  expect(status.output).not.toContain(server.discovery.token);
  const repo = await repository();

  const registered = await server.client.post<{ id: string }>("/repositories", {
    path: repo.directory,
  });

  const result = await server.client.post<Result>("/commands", {
    operation: {
      type: "create",
      title: "No UI",
      target: {
        kind: "commits",
        repositoryId: registered.id,
        base: repo.base,
        head: repo.head,
      },
    },
  });

  await expect(
    server.client.post(`/${result.reviewId}/open`, {}),
  ).rejects.toThrow(/No Whiteboard Desktop is attached/);
  await server.stop();
  const stopped = await cli(["server", "status", "--json"], server.env);
  expect(stopped.exitCode).toBe(1);
  expect(JSON.parse(stopped.output)).toMatchObject({ event: "error" });
  await expect(connectReviewApi(server.env)).rejects.toThrow(
    /whiteboard server start/g,
  );
});

/** A stand-in Desktop on `/control` that answers every verb relayed to it. */
async function attachDesktop(
  discovery: Pick<ReviewServerDiscovery, "url" | "token">,
) {
  const abort = new AbortController();
  const opened: JsonValue[] = [];
  const verbs: string[] = [];

  const control = await fetch(`${discovery.url}/control`, {
    headers: { "x-review-token": discovery.token },
    signal: abort.signal,
  });

  expect(control.status).toBe(200);

  void (async () => {
    let buffered = "";

    for await (const chunk of control.body!.pipeThrough(
      new TextDecoderStream(),
    )) {
      buffered += chunk;
      let end: number;

      while ((end = buffered.indexOf("\n\n")) >= 0) {
        const frame = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);

        if (!frame.startsWith("data: ")) continue;

        const { id, request } = parseReviewDesktopVerbFrame(
          JSON.parse(frame.slice("data: ".length)),
        );

        verbs.push(request.name);

        if (request.name === "openApiReview") opened.push(request.args);
        await fetch(`${discovery.url}/control/result`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-review-token": discovery.token,
          },
          body: JSON.stringify({
            id,
            response: { ok: true, result: { softwareMapEnabled: true } },
          }),
        });
      }
    }
  })().catch(() => {});

  return { opened, verbs, detach: () => abort.abort() };
}

it("reports attached Desktops and sends each the reviews to open", async () => {
  const server = await start();

  const desktops = [
    await attachDesktop(server.discovery),
    await attachDesktop(server.discovery),
  ];

  try {
    expect(await server.client.read("/capabilities")).toMatchObject({
      desktopAvailable: true,
      softwareMapEnabled: true,
    });

    const repo = await repository();

    const registered = await server.client.post<{ id: string }>(
      "/repositories",
      { path: repo.directory },
    );

    const created = await server.client.post<Result>("/commands", {
      operation: {
        type: "create",
        title: "Opened remotely",
        target: {
          kind: "commits",
          repositoryId: registered.id,
          base: repo.base,
          head: repo.head,
        },
        open: false,
      },
    });

    await server.client.post(`/${created.reviewId}/open`, {});

    // The first answer resolves the open; the other's may still be on its way.
    for (const desktop of desktops)
      await expect
        .poll(() => desktop.opened)
        .toEqual([{ reviewId: created.reviewId, title: "Opened remotely" }]);
  } finally {
    for (const desktop of desktops) desktop.detach();
  }

  await expect
    .poll(() => server.client.read("/capabilities"))
    .toMatchObject({ desktopAvailable: false });
});

it.each([false, true])(
  "never makes, lists or offers the scratchpad, with a Desktop attached: %s",
  async (attached) => {
    await writeScratchpadEnabled(true);
    const server = await start();
    const desktop = attached ? await attachDesktop(server.discovery) : null;

    try {
      expect(await server.client.read("/capabilities")).toMatchObject({
        desktopAvailable: attached,
        scratchpadEnabled: false,
      });
      expect(await server.client.read("")).toEqual([]);
      // The offer is a pointer to the scratchpad topic.
      const offer = 'topic:"scratchpad"';

      expect(
        (await server.client.read<{ description: string }[]>("/authoring"))
          .map((tool) => tool.description)
          .join("\n"),
      ).not.toContain(offer);
      expect(await server.client.read("/instructions")).not.toContain(offer);
      expect(
        await server.client.read("/instructions?topic=scratchpad"),
      ).toMatch(/turned off/);
    } finally {
      desktop?.detach();
    }

    await server.stop();

    const local = await openReviewProfile(server.stateDir, {
      manageWorkspaces: false,
    });

    try {
      expect(local.store.list()).toEqual([]);
    } finally {
      await local.data.close();
      await local.store.close();
    }
  },
);

/** A registered repository with an uncommitted change, reviewed as a worktree and as commits. */
async function reviewsOfBothKinds(client: ReviewApiClient) {
  const repo = await repository();
  await writeFile(
    path.join(repo.directory, "example.ts"),
    "export const value = 3;\n",
  );

  const { id: repositoryId } = await client.post<{ id: string }>(
    "/repositories",
    { path: repo.directory },
  );

  const create = async (target: JsonValue) =>
    (
      await client.post<Result>("/commands", {
        operation: { type: "create", title: "Remote", target, open: false },
      })
    ).reviewId;

  return {
    repo,
    root: await realpath(repo.directory),
    worktree: await create({ kind: "worktree", repositoryId, base: repo.base }),
    commits: await create({
      kind: "commits",
      repositoryId,
      base: repo.base,
      head: repo.head,
    }),
  };
}

const workspaceFiles = async () =>
  (await readdir(root, { recursive: true })).filter((entry) =>
    entry.endsWith(".code-workspace"),
  );

it("gives a remote caller no local paths and no source window", async () => {
  const server = await start();
  const desktop = await attachDesktop(server.discovery);

  try {
    const {
      repo,
      root: checkout,
      worktree,
      commits,
    } = await reviewsOfBothKinds(server.client);

    const call = (
      reviewId: string,
      route: string,
      remote: boolean,
      method = "GET",
    ) =>
      fetch(`${server.discovery.url}/reviews-api/${reviewId}${route}`, {
        method,
        headers: {
          "x-review-token": server.discovery.token,
          ...(remote && { [REVIEW_CLIENT_HEADER]: REVIEW_CLIENT_REMOTE }),
        },
      });

    const read = async (reviewId: string, route: string, remote: boolean) => {
      const response = await call(reviewId, route, remote);
      expect(response.status).toBe(200);

      return response.json();
    };

    const file = "/file?side=head&file=example.ts";
    const context = "/language-context?side=head";
    const hash = /^[0-9a-f]{64}$/;
    const home = await realpath(root);

    expect(await read(worktree, file, false)).toMatchObject({
      text: "export const value = 3;\n",
      localPath: path.join(checkout, "example.ts"),
      localRoot: checkout,
    });
    expect(await read(commits, file, false)).toEqual({
      file: "example.ts",
      side: "head",
      commit: repo.head,
      text: "export const value = 2;\n",
    });

    const localContext = await read(worktree, context, false);
    expect(localContext.rootPath).toBe(checkout);
    expect(localContext.identity).not.toMatch(hash);

    // A headless server prepares no commit checkouts, so only the worktree
    // review has a language context here.
    const remoteContext = await read(worktree, context, true);
    expect(remoteContext).toEqual({ identity: expect.stringMatching(hash) });
    expect(JSON.stringify(remoteContext)).not.toContain(home);

    for (const reviewId of [worktree, commits]) {
      const remoteFile = await read(reviewId, file, true);
      expect(remoteFile).toMatchObject({ text: expect.any(String) });
      expect(JSON.stringify(remoteFile)).not.toContain(home);

      const navigator = await call(reviewId, "/navigator", true, "POST");
      expect(navigator.status).toBe(409);
      expect(await navigator.json()).toEqual({
        error:
          "Source windows are not available for a review on another machine.",
      });
    }

    expect(await workspaceFiles()).toEqual([]);
    expect(desktop.verbs).toEqual([]);

    // The same search finds the file an unmarked call writes.
    const navigator = await call(worktree, "/navigator", false, "POST");
    expect(navigator.status).toBe(200);
    expect(await navigator.json()).toHaveProperty("workspacePath");
    expect(await workspaceFiles()).toHaveLength(1);
  } finally {
    desktop.detach();
  }
});

it("treats a near-miss client header as a local caller", async () => {
  const server = await start();
  const { root: checkout, worktree } = await reviewsOfBothKinds(server.client);
  const url = `${server.discovery.url}/reviews-api/${worktree}/file?side=head&file=example.ts`;

  // Sent as two header lines; the server joins them as "remote, remote".
  const twice = await new Promise<string>((resolve, reject) => {
    const request = httpRequest(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve(body));
    });

    request.setHeader("x-review-token", server.discovery.token);
    request.setHeader(REVIEW_CLIENT_HEADER, [
      REVIEW_CLIENT_REMOTE,
      REVIEW_CLIENT_REMOTE,
    ]);
    request.on("error", reject);
    request.end();
  });

  const capitalized = await fetch(url, {
    headers: {
      "x-review-token": server.discovery.token,
      [REVIEW_CLIENT_HEADER]: "Remote",
    },
  });

  for (const answer of [JSON.parse(twice), await capitalized.json()])
    expect(answer).toMatchObject({
      localPath: path.join(checkout, "example.ts"),
      localRoot: checkout,
    });
});

it("rejects a second owner and keeps separate CI job stores independent", async () => {
  const first = await start();
  await expect(
    runHeadlessServer({
      stateDir: first.stateDir,
      signal: new AbortController().signal,
      onReady: () => {},
    }),
  ).rejects.toThrow(/already owns/);
  const second = await start(path.join(root, "second"));
  expect(second.discovery.url).not.toBe(first.discovery.url);
  expect(await second.client.read("/capabilities")).toMatchObject({
    softwareMapEnabled: false,
  });
  const repo = await repository();

  const registered = await first.client.post<{ id: string }>("/repositories", {
    path: repo.directory,
  });

  await first.client.post("/commands", {
    operation: {
      type: "create",
      title: "First job only",
      target: {
        kind: "commits",
        repositoryId: registered.id,
        base: repo.base,
        head: repo.head,
      },
    },
  });
  expect(await first.client.read("")).toMatchObject([
    { title: "First job only" },
  ]);
  expect(await second.client.read("")).toEqual([]);
  await first.stop();
  expect(await reviewServerIsHealthy(second.discovery)).toBe(true);
});

it("releases ownership after a port bind failure so startup can be retried", async () => {
  const first = await start();
  const stateDir = path.join(root, "retry");
  await expect(
    runHeadlessServer({
      stateDir,
      port: Number(new URL(first.discovery.url).port),
      signal: new AbortController().signal,
      onReady: () => {},
    }),
  ).rejects.toThrow(/EADDRINUSE/);
  const retried = await start(stateDir);
  expect(await reviewServerIsHealthy(retried.discovery)).toBe(true);
});

it("binds a non-loopback address, keeps token auth, and stays reachable locally", async () => {
  const stderrWrite = vi.spyOn(process.stderr, "write");

  try {
    // start() connected its client through the discovery file already, so the
    // loopback URL it finds there proves `whiteboard api`/`mcp` keep working.
    const server = await start(undefined, false, "0.0.0.0");
    const { port } = new URL(server.discovery.url);

    expect(server.discovery.url).toBe(`http://127.0.0.1:${port}`);
    expect(await reviewServerIsHealthy(server.discovery)).toBe(true);
    expect((await fetch(`${server.discovery.url}/reviews-api`)).status).toBe(
      401,
    );

    const external = Object.values(networkInterfaces())
      .flat()
      .find((info) => info && !info.internal && info.family === "IPv4");

    const probed = external && {
      health: (
        await fetch(`http://${external.address}:${port}/health`, {
          headers: { "x-review-token": server.discovery.token },
        })
      ).status,
      api: (await fetch(`http://${external.address}:${port}/reviews-api`))
        .status,
    };

    expect(probed ?? { health: 200, api: 401 }).toEqual({
      health: 200,
      api: 401,
    });
    expect(
      stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join(""),
    ).toContain("token is the only protection");
  } finally {
    stderrWrite.mockRestore();
  }
});

it("does not connect to another instance through stale discovery", async () => {
  const server = await start();
  const discoveryPath = reviewServerDiscoveryPath(server.stateDir);
  const original = JSON.parse(await readFile(discoveryPath, "utf8"));
  await writeFile(
    discoveryPath,
    JSON.stringify({ ...original, instanceId: randomUUID() }),
  );
  await expect(connectReviewApi(server.env)).rejects.toThrow(/not ready/);
});

it("resets the server id only while no server holds the store", async () => {
  const server = await start();

  const before = await serverIdOf(server.discovery);

  const reset = [
    "--state-dir",
    server.stateDir,
    "server",
    "reset-id",
    "--json",
  ];

  const refused = await cli(reset, process.env);

  expect(refused.exitCode).toBe(1);
  expect(JSON.parse(refused.output).error.message).toMatch(/Stop it first/);
  expect(await serverIdOf(server.discovery)).toBe(before);

  await server.stop();

  // An unrelated instance selection must not get in the way.
  const done = await cli(reset, {
    ...process.env,
    DEV_REVIEW_INSTANCE: "Not A Key!",
  });

  expect(done).toMatchObject({ exitCode: 0, errors: "" });
  const { event, serverId: after } = JSON.parse(done.output);
  expect(event).toBe("server.reset-id");
  expect(after).not.toBe(before);

  const restarted = await start(server.stateDir);
  expect(await serverIdOf(restarted.discovery)).toBe(after);
});

it("resets the id over a lock its dead server left behind", async () => {
  const server = await start();
  await server.stop();
  const lock = headlessServerLockPath(await realpath(server.stateDir));
  await mkdir(lock);
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid }));

  const done = await cli(
    ["--state-dir", server.stateDir, "server", "reset-id", "--json"],
    process.env,
  );

  expect(done).toMatchObject({ exitCode: 0, errors: "" });
  await expect(access(lock)).rejects.toThrow(/ENOENT/);
});

it.each(["attached", "not yet attached"])(
  "refuses to reset the id of a store a Desktop holds, window %s",
  async (window) => {
    const local = await openReviewProfile(root, { manageWorkspaces: false });

    const desktop = createGlobalReviewServer({
      reviewStore: local.store,
      reviewData: local.data,
      appPid: process.pid,
      packageRoot: root,
      toolingRoot: root,
      port: 0,
      telemetry: ReviewTelemetry.fromEnv(process.env),
    });

    stops.push(async () => {
      await desktop.close();
      await local.data.close();
      await local.store.close();
    });
    await desktop.listen();
    const before = local.store.serverId();

    const attached =
      window === "attached" ? await attachDesktop(desktop.discovery) : null;

    try {
      const refused = await cli(
        ["--state-dir", root, "server", "reset-id", "--json"],
        process.env,
      );

      expect(refused.exitCode).toBe(1);
      expect(JSON.parse(refused.output).error.message).toMatch(/Stop it first/);
      expect(local.store.serverId()).toBe(before);
      expect(await serverIdOf(desktop.discovery)).toBe(before);
    } finally {
      attached?.detach();
    }
  },
);

it("refuses to reset the id while a Desktop record cannot be read", async () => {
  const local = await openReviewProfile(root, { manageWorkspaces: false });
  const before = local.store.serverId();
  await local.data.close();
  await local.store.close();
  const instances = path.join(root, "review-desktop", "instances");
  await mkdir(instances, { recursive: true });
  await writeFile(path.join(instances, "stable.json"), "not json");

  const refused = await cli(
    ["--state-dir", root, "server", "reset-id", "--json"],
    process.env,
  );

  expect(refused.exitCode).toBe(1);

  const reopened = await openReviewProfile(root, { manageWorkspaces: false });
  stops.push(async () => {
    await reopened.data.close();
    await reopened.store.close();
  });
  expect(reopened.store.serverId()).toBe(before);
});

it("refuses to reset the id where there is no store, and creates none", async () => {
  const typo = path.join(root, "no-such-state");

  const refused = await cli(
    ["--state-dir", typo, "server", "reset-id", "--json"],
    process.env,
  );

  expect(refused.exitCode).toBe(1);
  expect(JSON.parse(refused.output).error.message).toContain(typo);
  await expect(access(typo)).rejects.toThrow(/ENOENT/);
});

it("refuses the removed batch authoring mode instead of ignoring it", async () => {
  const result = await cli(
    [
      "--state-dir",
      path.join(root, "refused"),
      "server",
      "start",
      "--authoring-mode",
      "batch",
    ],
    process.env,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.errors).toContain("--authoring-mode was removed");
});

/** An executable `cursor-agent acp` stand-in: ACP over ndjson on stdio,
 * logging each request and its own pid for the shutdown check. */
const STUB_CURSOR_AGENT = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const record = (entry) =>
  process.env.STUB_ACP_LOG &&
  fs.appendFileSync(process.env.STUB_ACP_LOG, JSON.stringify(entry) + "\\n");

if (process.env.STUB_ACP_PID)
  fs.writeFileSync(process.env.STUB_ACP_PID, String(process.pid));

const modes = (current) => [
  {
    id: "mode",
    name: "Mode",
    type: "select",
    currentValue: current,
    options: [
      { value: "ask", name: "Ask" },
      { value: "agent", name: "Agent" },
    ],
  },
];

readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line);

    // Notifications carry no id and get no reply.
    if (message.id === undefined) return;

    const reply = (result) =>
      send({ jsonrpc: "2.0", id: message.id, result });
    const chunks = (text) =>
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        },
      });

    if (message.method === "initialize")
      reply({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false },
        },
        authMethods: [],
      });
    else if (message.method === "session/new") {
      record({ method: message.method, params: message.params });
      reply({ sessionId: "stub-session", configOptions: modes("agent") });
    } else if (message.method === "session/set_config_option") {
      record({ method: message.method, params: message.params });
      reply({ configOptions: modes(message.params.value) });
    } else if (message.method === "session/prompt") {
      record({ method: message.method, params: message.params });
      chunks("The stub checked: ");
      chunks("value is a constant.");
      reply({ stopReason: "end_turn" });
    } else
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: \`Unknown \${message.method}\` },
      });
  });
`;

/** An empty dir as PATH and HOME: no agent CLI exists to detect. */
async function withoutAgents() {
  const bin = path.join(root, "empty-bin");
  const home = path.join(root, "empty-home");
  await mkdir(bin);
  await mkdir(home);
  vi.stubEnv("PATH", bin);
  vi.stubEnv("HOME", home);
}

async function waitForServer(stateDir: string) {
  let discovery: ReviewServerDiscovery | null = null;

  await expect
    .poll(
      async () => {
        discovery = await readReviewServerDiscovery(stateDir);

        return discovery !== null && (await reviewServerIsHealthy(discovery));
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  return discovery!;
}

async function askAgentsRoute(
  discovery: Pick<ReviewServerDiscovery, "url" | "token">,
) {
  return fetch(`${discovery.url}/reviews-api/review/ask/agents`, {
    headers: { "x-review-token": discovery.token },
  });
}

it("answers a selection through an installed agent's ACP session and stops it with the server", async () => {
  const repo = await repository();

  // A stub `cursor-agent` on PATH speaks ACP; the server finds it, offers it
  // in the picker, and asks it. Its own log says where it worked.
  const bin = path.join(root, "bin");
  const stubLog = path.join(root, "stub-agent.log");
  const stubPid = path.join(root, "stub-agent.pid");
  await mkdir(bin);
  const stub = path.join(bin, "cursor-agent");
  await writeFile(stub, STUB_CURSOR_AGENT);
  await chmod(stub, 0o755);

  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  vi.stubEnv("STUB_ACP_LOG", stubLog);
  vi.stubEnv("STUB_ACP_PID", stubPid);

  const server = await start();

  const { id: repositoryId } = await server.client.post<{ id: string }>(
    "/repositories",
    { path: repo.directory },
  );

  const created = await server.client.post<Result>("/commands", {
    operation: {
      type: "create",
      title: "Asked",
      target: { kind: "worktree", repositoryId, base: repo.base },
      open: false,
    },
  });

  const reviewId = created.reviewId;

  const agents = await server.client.read<{ agents: AskAgentStatus[] }>(
    `/${reviewId}/ask/agents`,
  );

  expect(agents.agents.find((agent) => agent.id === "cursor")).toMatchObject({
    name: "Cursor",
    available: true,
    readOnly: true,
  });

  const { threadId } = await server.client.post<{ threadId: string }>(
    `/${reviewId}/ask`,
    {
      agent: "cursor",
      question: { text: "What does example.ts export?" },
      selection: {
        target: { kind: "text", quote: "export const value = 2;" },
        title: "example.ts",
      },
    },
  );

  const response = await fetch(
    `${server.discovery.url}/reviews-api/${reviewId}/ask/watch`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-review-token": server.discovery.token,
      },
      body: JSON.stringify({ threads: [threadId] }),
    },
  );

  expect(response.status).toBe(200);

  const reader = response
    .body!.pipeThrough(new TextDecoderStream())
    .getReader();

  const lines: AskWatchLine[] = [];
  let buffered = "";
  let state: AskThreadState | undefined;

  const drained = (async () => {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) return;
      buffered += value;

      let end: number;

      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end).trim();
        buffered = buffered.slice(end + 1);

        if (!line) continue;

        const parsed = askWatchLineSchema.parse(JSON.parse(line));
        lines.push(parsed);
        const update = "update" in parsed ? parsed.update : undefined;

        if (update && "snapshot" in update) state = update.snapshot;
        else if (update && state) state = applyAskChange(state, update.change);
      }
    }
  })();

  // The stub streams two chunks and ends the turn; the last state is idle.
  await expect
    .poll(() => (state?.status === "failed" ? state.error : state?.status), {
      timeout: 10_000,
    })
    .toBe("idle");
  expect(state).toMatchObject({
    agentName: "Cursor",
    readOnly: true,
    cwd: await realpath(repo.directory),
  });
  expect(
    state?.entries.some(
      (entry) =>
        entry.kind === "agent" &&
        entry.text.includes("The stub checked: value is a constant."),
    ),
  ).toBe(true);

  // The agent worked in the review's checkout, was set to its read-only ask
  // mode, and was told the selection and to leave files alone.
  const log = (await readFile(stubLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  expect(log.find((entry) => entry.method === "session/new")?.params.cwd).toBe(
    await realpath(repo.directory),
  );
  expect(
    log.find(
      (entry) =>
        entry.method === "session/set_config_option" &&
        entry.params.configId === "mode",
    )?.params.value,
  ).toBe("ask");

  const prompt = JSON.stringify(
    log.find((entry) => entry.method === "session/prompt")?.params.prompt,
  );

  expect(prompt).toContain("What does example.ts export?");
  expect(prompt).toContain("export const value = 2;");
  expect(prompt).toContain("Do not change files");

  const pid = Number(await readFile(stubPid, "utf8"));
  await server.stop();
  await drained;
  expect(lines.at(-1)).toEqual({ threadId, ended: true });
  await expect
    .poll(
      () => {
        try {
          process.kill(pid, 0);

          return true;
        } catch {
          return false;
        }
      },
      { timeout: 10_000 },
    )
    .toBe(false);
});

it("runs Ask only when it is enabled or an agent is installed", async () => {
  await withoutAgents();

  // With nothing installed to ask, the default server serves no Ask routes.
  const off = await start();
  expect((await askAgentsRoute(off.discovery)).status).toBe(404);
  await off.stop();

  // WHITEBOARD_ASK=1 turns Ask on; the picker reports each agent missing.
  const envDir = path.join(root, "env-ask");

  const byEnv = cli(["--state-dir", envDir, "server", "start"], {
    ...process.env,
    WHITEBOARD_ASK: "1",
  });

  try {
    const discovery = await waitForServer(envDir);
    const response = await askAgentsRoute(discovery);
    expect(response.status).toBe(200);

    const { agents } = (await response.json()) as {
      agents: AskAgentStatus[];
    };

    expect(agents.length).toBeGreaterThan(0);
    expect(agents.every((agent) => !agent.available)).toBe(true);
  } finally {
    process.emit("SIGINT");
    expect((await byEnv).exitCode).toBe(0);
  }

  // A flag beats the env: --no-ask with WHITEBOARD_ASK=1 stays off.
  const flagDir = path.join(root, "flag-ask");

  const byFlag = cli(["--state-dir", flagDir, "server", "start", "--no-ask"], {
    ...process.env,
    WHITEBOARD_ASK: "1",
  });

  try {
    const discovery = await waitForServer(flagDir);
    expect((await askAgentsRoute(discovery)).status).toBe(404);
  } finally {
    process.emit("SIGINT");
    expect((await byFlag).exitCode).toBe(0);
  }

  // --ask alone turns it on with nothing installed to ask.
  const askDir = path.join(root, "ask-on");

  const byAsk = cli(["--state-dir", askDir, "server", "start", "--ask"], {
    ...process.env,
    WHITEBOARD_ASK: "0",
  });

  try {
    const discovery = await waitForServer(askDir);
    expect((await askAgentsRoute(discovery)).status).toBe(200);
  } finally {
    process.emit("SIGINT");
    expect((await byAsk).exitCode).toBe(0);
  }
});

it("points the agents' Whiteboard tools at the server's state directory", () => {
  const stateDir = path.join(root, "asked-state");
  const cliPath = path.join(root, "dist", "cli.js");
  const tools = headlessAskTools(stateDir, cliPath);
  const [server] = tools.mcpServers!();

  expect(server).toEqual({
    name: "whiteboard",
    command: process.execPath,
    args: [cliPath, "mcp"],
    env: expect.arrayContaining([
      { name: "DEV_REVIEW_SERVER_DIR", value: stateDir },
      { name: "DEV_REVIEW_HOME", value: process.env.DEV_REVIEW_HOME },
    ]),
  });

  const command = tools.cli!();

  expect(command).toContain(`DEV_REVIEW_SERVER_DIR=${shellQuote(stateDir)}`);
  expect(command).toContain(shellQuote(cliPath));

  // A source checkout has no built CLI to advertise.
  expect(headlessAskTools(stateDir, undefined).mcpServers!()).toEqual([]);
  expect(headlessAskTools(stateDir, undefined).cli!()).toBeUndefined();
});
