import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { isObjectValue } from "@dev.fast/json";
import {
  shellQuote,
  withFileLock,
  writePrivateJsonAtomic,
} from "@dev.fast/trace-core";
import { detectAskAgents } from "@review/ask/agents.js";
import type { AskTools } from "@review/ask/threads.js";
import { findReviewPackageRoot } from "@review/package-paths.js";
import { openReviewProfile } from "@review/review-api/profile.js";
import {
  type ReviewServerDiscovery,
  headlessServerLockPath,
  reviewServerDiscoveryPath,
} from "@review/server-discovery.js";

import { migrateDiffrConfig } from "./diffr-config.js";
import { GlobalReviewDesktopVerbRelay } from "./global-verb-relay.js";
import { createNodeRequestListener } from "./hono-http.js";
import {
  drainServerCrashReport,
  installProcessErrorTelemetry,
} from "./process-error-telemetry.js";
import { createWhiteboardCore, serveWebCanvas } from "./review-server-core.js";
import type { ReviewTelemetryCapture } from "./ui-telemetry.js";
import { createWebSettings } from "./web-settings.js";

interface HeadlessServerInput {
  stateDir: string;
  port?: number;
  /** Bind address; a non-loopback one makes the API reachable from other machines. */
  host?: string;
  /** Serve the built web canvas from this directory on the same origin. */
  webDir?: string;
  /** Pin the auth token; one is generated and persisted when omitted. */
  token?: string;
  localBrowserAuth?: boolean;
  softwareMapEnabled?: boolean;
  /** Ask reviewers through an installed agent CLI; unset runs Ask when one
   * is detected. */
  ask?: boolean;
  signal: AbortSignal;
  /** The CLI's instance, already on the `headless` surface. */
  telemetry?: Pick<ReviewTelemetryCapture, "captureUiEvent">;
  onReady(discovery: ReviewServerDiscovery): void;
}

/** One foreground headless endpoint per profile; Desktop shares its database. */
export async function runHeadlessServer(input: HeadlessServerInput) {
  await mkdir(input.stateDir, { recursive: true, mode: 0o700 });
  const stateDir = await realpath(input.stateDir);

  const stopErrorTelemetry =
    input.telemetry && installProcessErrorTelemetry(input.telemetry);

  const outcome = await withHeadlessServerLock(stateDir, () =>
    serve({ ...input, stateDir }),
  ).finally(() => stopErrorTelemetry?.());

  if (!outcome.acquired)
    throw new Error(
      `A Whiteboard server already owns ${stateDir}. Stop it first, or choose another --state-dir.`,
    );
}

/** Held by a running server, so also by anything that must not run beside one. */
export function withHeadlessServerLock<T>(
  stateDir: string,
  operation: () => Promise<T>,
) {
  return withFileLock(
    headlessServerLockPath(stateDir),
    {
      timeoutMs: 0,
      retryMs: 20,
      // A paused live owner must never lose exclusive access to its store.
      staleMs: Infinity,
      unownedGraceMs: 1_000,
      // A reboot or kill can hand the pid to an unrelated live process.
      identifyOwner: true,
    },
    operation,
  );
}

async function serve(input: HeadlessServerInput) {
  if (input.signal.aborted) return;

  if (input.token !== undefined && input.token.length < 32)
    throw new Error("The server token must be at least 32 characters long.");

  await migrateDiffrConfig(input.signal);

  if (input.telemetry) await drainServerCrashReport(input.telemetry);

  const token = input.token ?? (await persistedServerToken(input.stateDir));

  const local = await openReviewProfile(input.stateDir, {
    manageWorkspaces: false,
  });

  const discovery: ReviewServerDiscovery = {
    version: 1,
    instanceId: randomUUID(),
    url: "http://127.0.0.1:0",
    serverPid: process.pid,
    token,
  };

  let localBrowserPort: number | undefined;
  const relay = new GlobalReviewDesktopVerbRelay();
  const settings = createWebSettings(input.stateDir);
  let persistedSettings = await settings.read();

  const ask =
    input.ask ?? (await detectAskAgents()).some((agent) => agent.available);

  const core = createWhiteboardCore({
    profile: local,
    relay,
    token: discovery.token,
    instanceId: discovery.instanceId,
    localBrowserAuth: input.localBrowserAuth,
    localBrowserPort: () => localBrowserPort,
    softwareMapEnabled: input.softwareMapEnabled,
    // The scratchpad is the laptop's alone, even with a Desktop attached.
    scratchpad: () => persistedSettings.scratchpadEnabled,
    webSettings: {
      read: settings.read,
      async update(patch) {
        persistedSettings = await settings.update(patch);

        return persistedSettings;
      },
    },
    status: () => ({ key: "headless", home: input.stateDir }),
    ask: ask ? { tools: headlessAskTools(input.stateDir) } : undefined,
    headlessOpenUrl: input.webDir
      ? (reviewId) =>
          headlessSessionUrl(discovery.url, discovery.token, reviewId)
      : undefined,
  });

  const { app, api } = core;

  app.route("/reviews-api", api);

  const server = createServer(
    createNodeRequestListener(
      input.webDir ? serveWebCanvas(app, input.webDir) : app,
      { requireHostOnReviewApi: input.localBrowserAuth },
    ),
  );

  let published = false;

  try {
    const listening = once(server, "listening");
    server.listen(input.port ?? 0, input.host || "127.0.0.1");
    await listening;
    const address = server.address();

    if (!isObjectValue(address))
      throw new Error("Whiteboard server did not bind a TCP port.");
    localBrowserPort = address.port;
    // Same-machine clients dial the discovery URL: a wildcard bind still gets
    // loopback, while a specific interface is only reachable by its own address.
    discovery.url = `http://${discoveryHost(address.address)}:${address.port}`;

    if (!isLoopbackAddress(address.address))
      process.stderr.write(
        `Whiteboard server is listening on ${address.address}, reachable from other machines; ${input.localBrowserAuth ? "local auth trusts Host and Origin and is unsafe when exposed" : "the token is the only protection"}.\n`,
      );
    await writePrivateJsonAtomic(
      reviewServerDiscoveryPath(input.stateDir),
      discovery,
    );
    published = true;
    input.onReady(discovery);

    if (input.webDir) process.stderr.write(`Setup: ${discovery.url}/setup\n`);

    await new Promise<void>((resolve) => {
      if (input.signal.aborted) resolve();
      else
        input.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    // Watch streams may live forever. Drain ordinary requests, then bound shutdown.
    const forceClose = setTimeout(() => server.closeAllConnections(), 5_000);
    forceClose.unref();

    try {
      if (published)
        await rm(reviewServerDiscoveryPath(input.stateDir), { force: true });
    } finally {
      // Ask agents run as this server's children; they stop with it.
      core.close();
      // An attached Desktop's stream would otherwise hold the close open.
      relay.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      clearTimeout(forceClose);

      try {
        await local.data.close();
      } finally {
        await local.store.close();
      }
    }
  }
}

async function persistedServerToken(stateDir: string) {
  const directory = path.join(stateDir, "review-server");
  const tokenPath = path.join(directory, "token");

  await mkdir(directory, { recursive: true, mode: 0o700 });

  try {
    const token = await readFile(tokenPath, "utf8");

    if (token.length < 32)
      throw new Error(`The persisted server token in ${tokenPath} is invalid.`);

    return token;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }

  const token = randomBytes(32).toString("base64url");

  try {
    await writeFile(tokenPath, token, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    return token;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  }

  const persistedToken = await readFile(tokenPath, "utf8");

  if (persistedToken.length < 32)
    throw new Error(`The persisted server token in ${tokenPath} is invalid.`);

  return persistedToken;
}

export function headlessSessionUrl(
  serverUrl: string,
  token: string,
  reviewId: string,
) {
  return `${serverUrl}/r/${encodeURIComponent(reviewId)}#token=${encodeURIComponent(token)}`;
}

function discoveryHost(bound: string) {
  if (bound === "0.0.0.0" || bound === "::") return "127.0.0.1";

  return bound.includes(":") ? `[${bound}]` : bound;
}

function isLoopbackAddress(bound: string) {
  const ipv4 = bound.startsWith("::ffff:") ? bound.slice(7) : bound;

  return ipv4 === "::1" || ipv4.startsWith("127.");
}

/** The package's built CLI, when there is one to advertise; a checkout run
 * from source has none, and its Ask sessions go without Whiteboard's tools. */
function whiteboardCliPath(): string | undefined {
  const cli = path.join(
    findReviewPackageRoot(import.meta.url),
    "dist",
    "cli.js",
  );

  return existsSync(cli) ? cli : undefined;
}

/** Whiteboard's tools for the server's Ask sessions: `whiteboard mcp` over
 * stdio, or `whiteboard api` from the agent's shell — each pointed at this
 * state directory so no other running Whiteboard answers the agent. */
export function headlessAskTools(
  stateDir: string,
  cliPath: string | null = whiteboardCliPath() ?? null,
): AskTools {
  const cli = cliPath ?? undefined;

  const cliEnv = () => [
    { name: "DEV_REVIEW_SERVER_DIR", value: stateDir },
    ...(process.versions.electron
      ? [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }]
      : []),
    ...(process.env.DEV_REVIEW_HOME
      ? [{ name: "DEV_REVIEW_HOME", value: process.env.DEV_REVIEW_HOME }]
      : []),
  ];

  return {
    mcpServers: () =>
      cli
        ? [
            {
              name: "whiteboard",
              command: process.execPath,
              args: [cli, "mcp"],
              env: cliEnv(),
            },
          ]
        : [],
    cli: () =>
      cli &&
      [
        ...cliEnv().map(({ name, value }) => `${name}=${shellQuote(value)}`),
        shellQuote(process.execPath),
        shellQuote(cli),
      ].join(" "),
  };
}
