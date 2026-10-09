import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadDeploymentConfig,
  publicDeploymentConfig,
} from "./deployment-config.js";
import { GlobalReviewDesktopVerbRelay } from "./global-verb-relay.js";
import { createReviewServerApp } from "./review-server-core.js";

const TOKEN = `setup-info-${"t".repeat(40)}`;

const PORT = 4321;

function app(input: { localBrowserAuth?: boolean } = {}) {
  return createReviewServerApp({
    token: TOKEN,
    instanceId: "test-instance",
    serverId: "test-server",
    relay: new GlobalReviewDesktopVerbRelay(),
    deployment: publicDeploymentConfig(loadDeploymentConfig({})),
    localBrowserAuth: input.localBrowserAuth,
    localBrowserPort: () => PORT,
  });
}

function get(
  server: ReturnType<typeof app>,
  url = `http://localhost:${PORT}/setup-info`,
  headers: Record<string, string> = {},
) {
  // The Host header rides a real request; Request(url) does not set it.
  return server.request(url, {
    headers: { host: new URL(url).host, ...headers },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /setup-info", () => {
  it("answers without a token and describes the server", async () => {
    vi.stubEnv("CODE_ROOT", "/home/dev/code");

    const response = await get(app());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      serverUrl: `http://localhost:${PORT}`,
      codeRoot: "/home/dev/code",
      localAuth: false,
      version: expect.any(String),
      healthy: true,
      deployment: {
        mode: "local",
        db: "sqlite",
        blobs: "fs",
        repoSource: "local",
        jobs: "inline",
        auth: "local-token",
      },
      // A local same-origin GET counts as a local browser request.
      token: TOKEN,
    });
  });

  it("reports a null codeRoot when CODE_ROOT is unset", async () => {
    vi.stubEnv("CODE_ROOT", "");

    const response = await get(app());

    expect(await response.json()).toMatchObject({ codeRoot: null });
  });

  it("never reveals the token while local browser auth is on", async () => {
    const server = app({ localBrowserAuth: true });

    const callers: Record<string, string>[] = [
      {},
      { "x-review-token": TOKEN },
      { origin: `http://localhost:${PORT}` },
    ];

    for (const headers of callers) {
      const response = await get(server, undefined, headers);

      expect(response.status).toBe(200);
      const info = await response.json();
      expect(info.localAuth).toBe(true);
      expect(info).not.toHaveProperty("token");
    }
  });

  it("reveals the token to an authorized request when local auth is off", async () => {
    const response = await get(
      app(),
      "http://whiteboard.internal:3000/setup-info",
      { "x-review-token": TOKEN },
    );

    expect(await response.json()).toMatchObject({
      localAuth: false,
      token: TOKEN,
    });
  });

  it("reveals the token to a local Host and Origin when local auth is off", async () => {
    const response = await get(app(), undefined, {
      origin: `http://localhost:${PORT}`,
    });

    expect(await response.json()).toMatchObject({ token: TOKEN });
  });

  it("withholds the token from foreign Hosts and cross-origin pages", async () => {
    const server = app();

    const responses = [
      await get(server, "http://rebind.attacker.test/setup-info"),
      await get(server, undefined, { origin: "http://attacker.test" }),
      await get(server, `http://localhost:${PORT + 1}/setup-info`),
      await get(server, undefined, {
        "x-review-token": "wrong",
        origin: "http://attacker.test",
      }),
    ];

    for (const response of responses) {
      expect(response.status).toBe(200);
      const info = await response.json();
      expect(info.localAuth).toBe(false);
      expect(info).not.toHaveProperty("token");
    }
  });
});
