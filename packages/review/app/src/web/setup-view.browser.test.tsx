import { settled } from "@canvas/fixture-review-bridge";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { type WebAppHandle, startWebCanvas } from "./web-app";

interface SetupInfo {
  serverUrl: string;
  codeRoot: string | null;
  localAuth: boolean;
  token?: string;
  version: string;
  healthy: boolean;
}

/** Answers the reads the web canvas makes on Home and /setup. */
function webFixtureRequest(info: SetupInfo) {
  const encoder = new TextEncoder();

  return (url: string, init?: RequestInit): Promise<Response> => {
    const { pathname } = new URL(url);

    if (pathname === "/setup-info") return Promise.resolve(Response.json(info));

    if (pathname === "/reviews-api") return Promise.resolve(Response.json([]));

    if (pathname === "/reviews-api/repositories")
      return Promise.resolve(Response.json([]));

    if (pathname === "/reviews-api/settings")
      return Promise.resolve(
        Response.json({
          theme: "system",
          documentWidth: "standard",
          codeFontSize: 14,
          softwareMapEnabled: false,
          structuralDiffEnabled: false,
          scratchpadEnabled: false,
        }),
      );

    if (pathname === "/reviews-api/watch") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('[{"value":[]}]\n'));
        },
      });

      return Promise.resolve(
        new Response(stream, {
          headers: { "content-type": "application/x-ndjson" },
        }),
      );
    }

    return Promise.resolve(
      Response.json({ error: `No fixture for ${pathname}` }, { status: 404 }),
    );
  };
}

describe("the /setup landing page", () => {
  let container: HTMLElement | undefined;
  let app: WebAppHandle | undefined;

  afterEach(async () => {
    await act(async () => app?.dispose());
    app = undefined;
    container?.remove();
    container = undefined;
    history.replaceState(null, "", "/");
    sessionStorage.clear();
  });

  const mount = async (path: string, info: SetupInfo) => {
    history.replaceState(null, "", path);
    container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      app = startWebCanvas(container!, {
        token: "test",
        serverUrl: "http://fixture.local",
        request: webFixtureRequest(info),
      });
    });
  };

  it("shows copyable connect commands with the server URL and token", async () => {
    await mount("/setup", {
      serverUrl: "http://fixture.local",
      codeRoot: "/code/mine",
      localAuth: false,
      token: "fixture-secret-token",
      version: "1.2.3",
      healthy: true,
    });

    expect(
      await settled(() =>
        container!.textContent?.includes("claude mcp add --transport http"),
      ),
    ).toBe(true);

    const claude = [...container!.querySelectorAll("pre")].find((pre) =>
      pre.textContent?.includes("claude mcp add --transport http"),
    )!;

    expect(claude.textContent).toBe(
      'claude mcp add --transport http whiteboard http://fixture.local/mcp --header "Authorization: Bearer fixture-secret-token"',
    );

    const codex = [...container!.querySelectorAll("pre")].find((pre) =>
      pre.textContent?.includes("[mcp_servers.whiteboard]"),
    )!;

    expect(codex.textContent).toContain('url = "http://fixture.local/mcp"');
    expect(codex.textContent).toContain(
      'bearer_token_env_var = "WHITEBOARD_TOKEN"',
    );
    expect(container!.textContent).not.toContain("npx");

    expect(container!.textContent).toContain("/code/mine");
    expect(container!.textContent).toContain("v1.2.3");
    expect(container!.textContent).toContain("~/.codex/config.toml");
    expect(container!.querySelectorAll('a[href="/"]').length).toBeGreaterThan(
      0,
    );
  });

  it("keeps the token out of the commands when local auth is on", async () => {
    await mount("/setup", {
      serverUrl: "http://localhost:3000",
      codeRoot: null,
      localAuth: true,
      version: "1.2.3",
      healthy: true,
    });

    expect(
      await settled(() =>
        container!.textContent?.includes("claude mcp add --transport http"),
      ),
    ).toBe(true);

    const claude = [...container!.querySelectorAll("pre")].find((pre) =>
      pre.textContent?.includes("claude mcp add --transport http"),
    )!;

    expect(claude.textContent).toBe(
      "claude mcp add --transport http whiteboard http://localhost:3000/mcp",
    );
    expect(container!.textContent).not.toContain("Authorization: Bearer");
  });

  it("points at the server logs when token mode hides the token", async () => {
    await mount("/setup", {
      serverUrl: "http://localhost:3000",
      codeRoot: null,
      localAuth: false,
      version: "1.2.3",
      healthy: true,
    });

    expect(
      await settled(() => container!.textContent?.includes("Bearer <token>")),
    ).toBe(true);
    expect(container!.textContent).toContain("docker compose logs");
  });

  it("offers a retry when the setup info cannot be read", async () => {
    history.replaceState(null, "", "/setup");
    container = document.createElement("div");
    document.body.append(container);

    let fail = true;

    const fixture = webFixtureRequest({
      serverUrl: "http://fixture.local",
      codeRoot: null,
      localAuth: true,
      version: "1.2.3",
      healthy: true,
    });

    const request = (url: string, init?: RequestInit) =>
      new URL(url).pathname === "/setup-info" && fail
        ? ((fail = false),
          Promise.resolve(
            Response.json({ error: "unavailable" }, { status: 503 }),
          ))
        : fixture(url, init);

    await act(async () => {
      app = startWebCanvas(container!, {
        token: "test",
        serverUrl: "http://fixture.local",
        request,
      });
    });

    expect(await settled(() => container!.textContent?.includes("(503)"))).toBe(
      true,
    );

    await act(async () => {
      [...container!.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Retry")!
        .click();
    });

    expect(
      await settled(() =>
        container!.textContent?.includes(
          "claude mcp add --transport http whiteboard",
        ),
      ),
    ).toBe(true);
  });

  it("links Home to /setup", async () => {
    await mount("/", {
      serverUrl: "http://fixture.local",
      codeRoot: null,
      localAuth: true,
      version: "1.2.3",
      healthy: true,
    });

    expect(
      await settled(() => container!.textContent?.includes("No sessions yet")),
    ).toBe(true);
    expect(container!.querySelector('a[href="/setup"]')).not.toBeNull();
  });
});
