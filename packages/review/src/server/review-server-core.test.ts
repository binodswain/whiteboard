import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openLocalReviewStore } from "@review/review-api/local-data.js";
import { ReviewTelemetry } from "@review/review-telemetry.js";
import { reviewServerDiscoveryPath } from "@review/server-discovery.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGlobalReviewServer } from "./desktop-server.js";
import { GlobalReviewDesktopVerbRelay } from "./global-verb-relay.js";
import { runHeadlessServer } from "./headless-host.js";
import { createWhiteboardCore } from "./review-server-core.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let root: string;

const stops: (() => Promise<void>)[] = [];

it("constructs the configured S3 blob store on the Whiteboard core", async () => {
  const profile = await openLocalReviewStore(path.join(root, "review-api.db"));

  const core = createWhiteboardCore({
    profile,
    relay: new GlobalReviewDesktopVerbRelay(),
    token: "test-token-0000000000000000000000000000",
    instanceId: "test-instance",
    scratchpad: () => false,
    status: () => ({}),
    deploymentConfig: {
      mode: "remote",
      db: "postgres",
      blobs: "s3",
      repoSource: "github",
      jobs: "queue",
      auth: "oauth",
      postgresUrl: "postgres://whiteboard:secret@db/whiteboard",
      s3: {
        bucket: "whiteboard",
        endpoint: "https://objects.example.invalid",
        region: "us-east-1",
        key: "access-key",
        secret: "secret-key",
      },
    },
  });

  expect(core.blobStore.signedReadUrl).toBeTypeOf("function");
  stops.push(async () => {
    await profile.data.close();
    await profile.store.close();
  });
});

it("constructs the configured GitHub repo source on the Whiteboard core", async () => {
  const profile = await openLocalReviewStore(path.join(root, "repo-source.db"));

  const core = createWhiteboardCore({
    profile,
    relay: new GlobalReviewDesktopVerbRelay(),
    token: "test-token-0000000000000000000000000000",
    instanceId: "test-instance",
    scratchpad: () => false,
    status: () => ({}),
    deploymentConfig: {
      mode: "remote",
      db: "postgres",
      blobs: "fs",
      repoSource: "github",
      jobs: "queue",
      auth: "oauth",
      postgresUrl: "postgres://whiteboard:secret@db/whiteboard",
    },
  });

  await expect(
    core.repoSource.checkout({
      repo: "/not/a/github/repository",
      baseSha: "base",
      headSha: "head",
    }),
  ).rejects.toThrow("Repository must identify a GitHub repository.");
  stops.push(async () => {
    await profile.data.close();
    await profile.store.close();
  });
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "review-server-core-"));
  vi.stubEnv("DEV_REVIEW_HOME", root);
  vi.stubEnv("DEV_FAST_REVIEW_TELEMETRY_DISABLED", "1");
});

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

interface Running {
  url: string;
  token: string;
}

const servers = {
  async desktop(): Promise<Running> {
    const local = await openLocalReviewStore(path.join(root, "review-api.db"));

    const server = createGlobalReviewServer({
      reviewStore: local.store,
      reviewData: local.data,
      appPid: process.pid,
      packageRoot: root,
      toolingRoot: root,
      port: 0,
      discoveryPath: path.join(root, "desktop-server.json"),
      telemetry: ReviewTelemetry.fromEnv(process.env),
    });

    stops.push(async () => {
      await server.close();
      await local.data.close();
      await local.store.close();
    });
    await server.listen();

    return server.discovery;
  },
  async headless(
    options: { host?: string; localBrowserAuth?: boolean } = {},
  ): Promise<Running> {
    const controller = new AbortController();
    const ready = Promise.withResolvers<Running>();

    const running = runHeadlessServer({
      stateDir: path.join(root, "server"),
      host: options.host,
      localBrowserAuth: options.localBrowserAuth,
      signal: controller.signal,
      onReady: ready.resolve,
    });

    stops.push(async () => {
      controller.abort();
      await running;
    });

    return ready.promise;
  },
};

describe.each(["desktop", "headless"] as const)("the %s server", (kind) => {
  const start = servers[kind];

  it("answers /health without a token, but names no machine or build", async () => {
    const server = await start();

    const callers: Record<string, string>[] = [
      {},
      { "x-review-token": "wrong" },
    ];

    for (const headers of callers) {
      const response = await fetch(`${server.url}/health`, { headers });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        instanceId: expect.stringMatching(uuid),
        desktopAttached: false,
        version: expect.any(String),
        deployment: {
          mode: "local",
          db: "sqlite",
          blobs: "fs",
          repoSource: "local",
          jobs: "inline",
          auth: "local-token",
        },
      });
    }
  });

  it("says which store, process and build answer /health to the token", async () => {
    const server = await start();

    const health = await (
      await fetch(`${server.url}/health`, {
        headers: { "x-review-token": server.token },
      })
    ).json();

    expect(health).toMatchObject({
      serverId: expect.stringMatching(uuid),
      serverPid: process.pid,
      version: JSON.parse(
        await readFile(path.join(packageRoot, "package.json"), "utf8"),
      ).version,
      // From source there is no build, whatever an old dist holds.
      commit: null,
    });
    expect(health.instanceId).not.toBe(health.serverId);
  });

  it("answers an unknown path with a JSON 404", async () => {
    const server = await start();
    const headers = { "x-review-token": server.token };

    for (const route of ["/nothing-here", "/reviews-api/nothing/here/at/all"]) {
      const response = await fetch(`${server.url}${route}`, { headers });

      expect({
        route,
        status: response.status,
        body: await response.json(),
      }).toEqual({
        route,
        status: 404,
        body: { ok: false, error: "Not found." },
      });
    }
  });

  it("refuses every other route without the right token", async () => {
    const server = await start();

    for (const token of [undefined, "wrong"])
      for (const [method, route] of [
        ["GET", "/reviews-api"],
        ["GET", "/control"],
        ["POST", "/control/result"],
      ] as const) {
        const response = await fetch(`${server.url}${route}`, {
          method,
          headers: token ? { "x-review-token": token } : {},
        });

        expect(response.status, `${method} ${route}`).toBe(401);
      }
  });

  it("answers a preflight from the Desktop's origin with CORS headers", async () => {
    const server = await start();
    const origin = "vscode-file://vscode-app";

    const response = await fetch(`${server.url}/reviews-api`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-review-token",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "x-review-token",
    );
    expect(
      (
        await fetch(`${server.url}/health`, { headers: { origin } })
      ).headers.get("access-control-allow-origin"),
    ).toBe(origin);
  });

  // Each Desktop window attaches its own stream; the Desktop keeps one so a
  // verb never opens in every window.
  const limit = { desktop: 1, headless: 16 }[kind];

  it(`refuses a /control client beyond ${limit} with a well-formed response`, async () => {
    const server = await start();
    const headers = { "x-review-token": server.token };
    const abort = new AbortController();

    try {
      for (let index = 0; index < limit; index++) {
        const attached = await fetch(`${server.url}/control`, {
          headers,
          signal: abort.signal,
        });

        expect(attached.status).toBe(200);
      }

      const refused = await fetch(`${server.url}/control`, { headers });

      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ ok: false });

      // Node's parser rejects a reply framed both ways.
      const [raw] = await once(
        http.request(`${server.url}/control`, { headers }).end(),
        "response",
      );

      expect(raw.statusCode).toBe(409);
      expect(
        raw.headers["transfer-encoding"] && raw.headers["content-length"],
      ).toBeFalsy();
      await once(raw.resume(), "end");
    } finally {
      abort.abort();
    }
  });

  it("answers a malformed /control/result with a JSON 400", async () => {
    const server = await start();

    const response = await fetch(`${server.url}/control/result`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-review-token": server.token,
      },
      body: "not json",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Invalid JSON body.",
    });
  });
});

it("allows tokenless local auth only for an explicitly enabled loopback Host", async () => {
  const server = await servers.headless({
    host: "0.0.0.0",
    localBrowserAuth: true,
  });

  const host = new URL(server.url).host;
  const origin = `http://${host}`;

  const request = (
    route: string,
    headers: Record<string, string>,
    method = "GET",
  ) =>
    new Promise<Response>((resolve, reject) => {
      const requestHeaders: http.OutgoingHttpHeaders = { host, ...headers };

      if (method === "POST")
        requestHeaders["content-type"] = "application/json";

      const incoming = http.request(
        new URL(route, server.url),
        { method, setHost: false, headers: requestHeaders },
        (response) => {
          const chunks: Buffer[] = [];

          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode,
              }),
            ),
          );
        },
      );

      incoming.on("error", reject);

      if (method === "POST") incoming.write("{}");
      incoming.end();
    });

  const catalog = await request("/reviews-api", { origin });
  const catalogWithoutOrigin = await request("/reviews-api", {});

  expect(catalog.status).toBe(200);
  expect(catalogWithoutOrigin.status).toBe(200);
  expect(await catalog.json()).toEqual([]);
  expect(await catalogWithoutOrigin.json()).toEqual([]);
  expect(
    await (await request("/reviews-api/capabilities", { origin })).json(),
  ).toMatchObject({ localBrowserAuth: true });

  const localMutation = await request(
    "/reviews-api/commands",
    { origin },
    "POST",
  );

  const localMutationWithoutOrigin = await request(
    "/reviews-api/commands",
    {},
    "POST",
  );

  expect(localMutation.status).toBe(400);
  expect(localMutationWithoutOrigin.status).toBe(400);

  const localHealth = await request("/health", {});
  const localControlResult = await request("/control/result", {}, "POST");

  expect(localHealth.status).toBe(200);
  expect(await localHealth.json()).toMatchObject({
    serverId: expect.stringMatching(uuid),
  });
  expect(localControlResult.status).toBe(400);

  const missingHost = await new Promise<number | undefined>(
    (resolve, reject) => {
      const incoming = http.request(
        {
          hostname: "127.0.0.1",
          port: Number(new URL(server.url).port),
          path: "/reviews-api",
          setHost: false,
        },
        (response) => resolve(response.statusCode),
      );

      incoming.on("error", reject);
      incoming.end();
    },
  );

  expect(missingHost).toBe(400);

  for (const [route, headers, method] of [
    ["/reviews-api", { host: "rebind.attacker.test", origin }, "GET"],
    ["/reviews-api", { host: "rebind.attacker.test" }, "POST"],
    [
      "/reviews-api",
      { host: `localhost:${Number(new URL(server.url).port) + 1}`, origin },
      "GET",
    ],
    ["/reviews-api", { origin: "http://attacker.test" }, "GET"],
    ["/reviews-api/commands", { origin: "http://attacker.test" }, "POST"],
  ] as const) {
    const response = await request(route, headers, method);

    expect(
      response.status,
      `${method} ${route} ${JSON.stringify(headers)}`,
    ).toBe(403);
  }

  const tokenAuthorized = await request("/reviews-api", {
    host: "rebind.attacker.test",
    origin: "http://attacker.test",
    "x-review-token": server.token,
  });

  expect(tokenAuthorized.status).toBe(200);

  const bearerAuthorized = await request("/reviews-api", {
    host: "rebind.attacker.test",
    origin: "http://attacker.test",
    authorization: `Bearer ${server.token}`,
  });

  expect(bearerAuthorized.status).toBe(200);
});

it("keeps token auth enabled by default on a wildcard bind", async () => {
  const server = await servers.headless({ host: "0.0.0.0" });

  expect((await fetch(`${server.url}/reviews-api`)).status).toBe(401);
});

// The servers as they run: the Desktop's host process and `server start`.
const processes = {
  desktop: (home: string) =>
    spawnSource("src/server/desktop-host.ts", [], {
      DEV_REVIEW_HOME: home,
      DEV_FAST_REVIEW_SERVER_PORT: "0",
      DEV_FAST_REVIEW_APP_PID: String(process.pid),
    }),
  headless: (
    home: string,
    stateDir = path.join(home, "server"),
    env: Record<string, string> = {},
  ) =>
    spawnSource(
      "src/cli.ts",
      ["server", "start", "--json", "--state-dir", stateDir],
      { DEV_REVIEW_HOME: home, ...env },
    ),
};

it("enables tokenless browser auth only from the explicit server environment flag", async () => {
  const stateDir = path.join(root, "local-browser-server");

  const child = processes.headless(root, stateDir, {
    WHITEBOARD_LOCAL_BROWSER_AUTH: "1",
  });

  try {
    const server = await discovery("headless", child, stateDir);
    const catalog = await fetch(`${server.url}/reviews-api`);
    const capabilities = await fetch(`${server.url}/reviews-api/capabilities`);

    expect(catalog.status).toBe(200);
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toMatchObject({ localBrowserAuth: true });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");

      child.kill("SIGTERM");
      await exited;
    }
  }
});

it("gives the Desktop and headless servers on one home one serverId, and another home another", async () => {
  const other = path.join(root, "other");

  // Started together, so both race to create the id.
  const children = [
    ["desktop", processes.desktop(root), undefined],
    ["headless", processes.headless(root, root), root],
    ["headless", processes.headless(other, other), other],
  ] as const;

  try {
    const [desktop, headless, elsewhere] = await Promise.all(
      children.map(async ([kind, child, stateDir]) => {
        const server = await discovery(kind, child, stateDir);

        return (
          await (
            await fetch(`${server.url}/health`, {
              headers: { "x-review-token": server.token },
            })
          ).json()
        ).serverId;
      }),
    );

    expect(desktop).toMatch(uuid);
    expect(headless).toBe(desktop);
    expect(elsewhere).toMatch(uuid);
    expect(elsewhere).not.toBe(desktop);
  } finally {
    await Promise.all(
      children.map(async ([, child]) => {
        if (child.exitCode !== null) return;
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }),
    );
  }
}, 30_000);

it.each([
  ["desktop", 1],
  ["headless", 1],
  ["headless", 2],
] as const)(
  "the %s server exits on SIGTERM with %i /control clients attached",
  async (kind, clients) => {
    const child = processes[kind](root);
    const exited = once(child, "exit");

    try {
      const server = await discovery(kind, child);

      for (let index = 0; index < clients; index++) {
        const control = await fetch(`${server.url}/control`, {
          headers: { "x-review-token": server.token },
        });

        expect(control.status).toBe(200);
      }

      child.kill("SIGTERM");

      // Under the headless server's 5 s force-close: the relay must end the
      // streams itself.
      let timer: NodeJS.Timeout | undefined;

      const [code] = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("still running after 3 s")),
            3_000,
          );
        }),
      ]).finally(() => clearTimeout(timer));

      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
    }
  },
  20_000,
);

it("refuses to reset the id while a paused headless server holds the store", async ({
  onTestFinished,
}) => {
  const stateDir = path.join(root, "server");
  const child = processes.headless(root, stateDir);
  const exited = once(child, "exit");

  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGCONT");
      child.kill("SIGKILL");
    }

    await exited;
  });

  const server = await discovery("headless", child, stateDir);

  const serverId = async () =>
    (
      await (
        await fetch(`${server.url}/health`, {
          headers: { "x-review-token": server.token },
        })
      ).json()
    ).serverId;

  const before = await serverId();
  child.kill("SIGSTOP");

  const reset = spawnSource(
    "src/cli.ts",
    ["--state-dir", stateDir, "server", "reset-id", "--json"],
    { DEV_REVIEW_HOME: root },
  );

  let output = "";
  reset.stdout!.on("data", (chunk) => (output += chunk));
  const [code] = await once(reset, "exit");

  expect(code).toBe(1);
  expect(JSON.parse(output).error.message).toMatch(/Stop it first/);

  child.kill("SIGCONT");
  expect(await serverId()).toBe(before);

  const local = await openLocalReviewStore(
    path.join(stateDir, "review-api.db"),
  );

  onTestFinished(async () => {
    await local.data.close();
    await local.store.close();
  });
  expect(await local.store.serverId()).toBe(before);
}, 30_000);

function spawnSource(
  entry: string,
  args: string[],
  env: Record<string, string>,
): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", entry, ...args], {
    cwd: packageRoot,
    env: {
      ...process.env,
      ...env,
      DEV_FAST_REVIEW_TELEMETRY_DISABLED: "1",
      DEV_FAST_REVIEW_CLI_NO_DELEGATE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function discovery(
  kind: string,
  child: ChildProcess,
  stateDir = path.join(root, "server"),
): Promise<Running> {
  let output = "";
  let errors = "";
  const ready = Promise.withResolvers<void>();

  child.stdout!.on("data", (chunk) => {
    output += chunk;

    if (/"(ready|server\.ready)"/.test(output)) ready.resolve();
  });
  child.stderr!.on("data", (chunk) => {
    errors += chunk;
  });
  child.once("exit", (code, signal) =>
    ready.reject(
      new Error(
        `The ${kind} server exited before ready (${signal ?? code}):\n${errors}`,
      ),
    ),
  );
  await ready.promise;

  if (kind === "desktop")
    return JSON.parse(
      output.split("\n").find((line) => line.includes('"ready"'))!,
    );

  return JSON.parse(
    await readFile(reviewServerDiscoveryPath(stateDir), "utf8"),
  );
}
