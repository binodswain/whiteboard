import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createReviewApi } from "@review/review-api/http.js";
import { type ReviewProviders, ReviewStore } from "@review/review-api/store.js";
import { publicDeploymentConfig } from "@review/server/deployment-config.js";
import { GlobalReviewDesktopVerbRelay } from "@review/server/global-verb-relay.js";
import { createReviewServerApp } from "@review/server/review-server-core.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuthDriver } from "./index.js";
import { createOAuthDriver } from "./oauth.js";
import {
  createGitHubAppCredentials,
  createRepoAccess,
  githubRepoSlug,
} from "./repo-access.js";
import { API_TOKEN_PREFIX, createApiTokens } from "./tokens.js";

let dir: string;

let store: ReviewStore;

const providers: ReviewProviders = {
  validatePins: async () => {},
  validateSource: async () => {},
  validateResource: async () => {},
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "whiteboard-auth-"));
  store = await ReviewStore.open(path.join(dir, "reviews.db"), providers);
});

afterEach(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

/** A fetch stub keyed on `${method} ${url}` suffixes; unmatched routes 404. */
function stubFetch(
  routes: Record<string, { status?: number; body?: unknown }>,
) {
  const calls: string[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);

    for (const [route, answer] of Object.entries(routes))
      if (`${method} ${url}`.endsWith(route) || url.endsWith(route))
        return Response.json(answer.body ?? {}, {
          status: answer.status ?? 200,
        });

    return Response.json({ message: "Not found" }, { status: 404 });
  }) as typeof fetch;

  return { fetchImpl, calls };
}

/** An OAuth driver over the test store, with the GitHub HTTP calls stubbed. */
function oauthDriver(
  fetchImpl: typeof fetch,
  options: {
    oauth?: { clientId: string; clientSecret: string } | null;
    proxy?: { header: string; secret: string; secretHeader: string };
  } = {},
) {
  return createOAuthDriver({
    meta: store.metadata,
    secret: "test-auth-secret",
    webUrl: "https://github.test",
    apiUrl: "https://api.github.test",
    oauth:
      options.oauth === null
        ? undefined
        : (options.oauth ?? {
            clientId: "client-id",
            clientSecret: "client-secret",
          }),
    proxy: options.proxy,
    fetchImpl,
  });
}

const sessionCookie = (response: Response): string =>
  response.headers.get("set-cookie")?.match(/wb_session=([^;]+)/)?.[1] ?? "";

/** Signs a viewer in through the stubbed OAuth loop; returns the callback
 * response — `sessionCookie()` extracts the session id from it. */
async function signIn(
  routes: {
    request: (
      input: string,
      requestInit?: RequestInit,
    ) => Promise<Response> | Response;
  },
  prefix = "",
) {
  const started = await routes.request(`${prefix}/github`);

  const state = new URL(started.headers.get("location")!).searchParams.get(
    "state",
  )!;

  const nonce =
    started.headers.get("set-cookie")?.match(/wb_oauth_nonce=([^;]+)/)?.[1] ??
    "";

  return routes.request(
    `${prefix}/github/callback?code=c&state=${encodeURIComponent(state)}`,
    { headers: { cookie: `wb_oauth_nonce=${nonce}` } },
  );
}

describe("githubRepoSlug", () => {
  it("recognizes the remote spellings a checkout uses", () => {
    expect(githubRepoSlug("https://github.com/acme/widgets")).toBe(
      "acme/widgets",
    );
    expect(githubRepoSlug("https://github.com/acme/widgets.git")).toBe(
      "acme/widgets",
    );
    expect(githubRepoSlug("git@github.com:acme/widgets.git")).toBe(
      "acme/widgets",
    );
    expect(githubRepoSlug("acme/widgets")).toBe("acme/widgets");
    expect(githubRepoSlug("ACME/Widgets")).toBe("acme/widgets");
  });

  it("rejects other hosts, local paths and partial urls", () => {
    expect(githubRepoSlug("https://gitlab.com/acme/widgets")).toBeUndefined();
    expect(githubRepoSlug("/home/dev/widgets")).toBeUndefined();
    expect(githubRepoSlug("acme")).toBeUndefined();
    expect(
      githubRepoSlug("https://github.com/acme/widgets/issues"),
    ).toBeUndefined();
    expect(githubRepoSlug("https://github.com/../etc")).toBeUndefined();
  });
});

describe("createApiTokens", () => {
  beforeEach(async () => {
    const now = new Date().toISOString();

    for (const id of ["u1", "u2"])
      await store.metadata.run(
        "INSERT INTO auth_users(id,login,created_at,updated_at) VALUES(?,?,?,?)",
        id,
        id,
        now,
        now,
      );
  });

  it("mints a wbt_ token, lists it without the secret and authenticates it", async () => {
    const tokens = createApiTokens(store.metadata);

    const created = await tokens.create("u1", "laptop");

    expect(created.token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(await tokens.list("u1")).toEqual([
      {
        id: created.id,
        name: "laptop",
        createdAt: created.createdAt,
        lastUsedAt: null,
      },
    ]);
    // The raw token is never persisted.
    expect(
      await store.metadata.get(
        "SELECT 1 AS x FROM auth_api_tokens WHERE token_hash=?",
        created.token,
      ),
    ).toBeUndefined();

    expect(await tokens.authenticate(created.token)).toBe("u1");
    expect(await tokens.authenticate("wbt_wrong")).toBeNull();
    expect(await tokens.authenticate("unrelated")).toBeNull();
  });

  it("stops authenticating a revoked token immediately", async () => {
    const tokens = createApiTokens(store.metadata);
    const created = await tokens.create("u1", "laptop");

    expect(await tokens.authenticate(created.token)).toBe("u1");
    expect(await tokens.revoke("u1", created.id)).toBe(true);
    expect(await tokens.authenticate(created.token)).toBeNull();
    // Another user's id cannot revoke it.
    expect(await tokens.revoke("u2", created.id)).toBe(false);
  });
});

describe("createRepoAccess", () => {
  beforeEach(async () => {
    const now = new Date().toISOString();

    for (const id of ["gh:1", "proxy:ada"])
      await store.metadata.run(
        "INSERT INTO auth_users(id,login,created_at,updated_at) VALUES(?,?,?,?)",
        id,
        id,
        now,
        now,
      );
  });

  const principal = {
    id: "gh:1",
    login: "ada",
    via: "github" as const,
    githubToken: "gho_test",
  };

  it("caches a user's verdict instead of re-asking GitHub", async () => {
    const { fetchImpl, calls } = stubFetch({
      "/repos/acme/widgets": { status: 200 },
    });

    const access = createRepoAccess({
      meta: store.metadata,
      apiUrl: "https://api.github.test",
      webUrl: "https://github.test",
      fetchImpl,
    });

    expect(
      await access.canRead(principal, "https://github.test/acme/widgets"),
    ).toBe(true);
    expect(
      await access.canRead(principal, "https://github.test/acme/widgets"),
    ).toBe(true);
    expect(
      calls.filter((call) => call.endsWith("/repos/acme/widgets")),
    ).toHaveLength(1);
  });

  it("denies a repository GitHub hides from the user", async () => {
    const { fetchImpl } = stubFetch({
      "/repos/acme/secret": { status: 404 },
    });

    const access = createRepoAccess({
      meta: store.metadata,
      apiUrl: "https://api.github.test",
      webUrl: "https://github.test",
      fetchImpl,
    });

    expect(
      await access.canRead(principal, "https://github.test/acme/secret"),
    ).toBe(false);
  });

  it("does not cache a transient failure", async () => {
    const { fetchImpl, calls } = stubFetch({
      "/repos/acme/widgets": { status: 500 },
    });

    const access = createRepoAccess({
      meta: store.metadata,
      apiUrl: "https://api.github.test",
      webUrl: "https://github.test",
      fetchImpl,
    });

    expect(
      await access.canRead(principal, "https://github.test/acme/widgets"),
    ).toBe(false);
    expect(
      await access.canRead(principal, "https://github.test/acme/widgets"),
    ).toBe(false);
    // An outage must not become a permanent deny: each call asks again.
    expect(calls.length).toBeGreaterThan(2);
  });

  it("lets a proxy user read a public repository without a token", async () => {
    const { fetchImpl } = stubFetch({
      "/repos/acme/widgets": { status: 200 },
    });

    const access = createRepoAccess({
      meta: store.metadata,
      apiUrl: "https://api.github.test",
      webUrl: "https://github.test",
      fetchImpl,
    });

    expect(
      await access.canRead(
        { id: "proxy:ada", login: "ada", via: "proxy" },
        "acme/widgets",
      ),
    ).toBe(true);
  });
});

describe("createGitHubAppCredentials", () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  it("mints an installation token per repository and caches it", async () => {
    const { fetchImpl, calls } = stubFetch({
      "/repos/acme/widgets/installation": { status: 200, body: { id: 77 } },
      "/app/installations/77/access_tokens": {
        status: 201,
        body: {
          token: "ghs_installation_token",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        },
      },
    });

    const app = createGitHubAppCredentials({
      app: { appId: "1234", privateKey },
      apiUrl: "https://api.github.test",
      fetchImpl,
    });

    expect(await app.installationToken("acme/widgets")).toBe(
      "ghs_installation_token",
    );
    // Second call reuses the live token — no extra mint or lookup.
    expect(await app.installationToken("acme/widgets")).toBe(
      "ghs_installation_token",
    );
    expect(calls.filter((call) => call.includes("access_tokens"))).toHaveLength(
      1,
    );
  });
});

describe("oauth driver", () => {
  it("answers session state, signs a viewer in through GitHub and back out", async () => {
    const { fetchImpl } = stubFetch({
      "/login/oauth/access_token": { body: { access_token: "gho_viewer" } },
      "/user": {
        body: { id: 42, login: "ada", name: "Ada", avatar_url: "" },
      },
    });

    const driver = oauthDriver(fetchImpl);

    const anonymous = await driver.routes.request("/session");
    expect(await anonymous.json()).toMatchObject({
      authenticated: false,
      signIn: "/auth/github",
    });

    // /github redirects to the provider with a signed state.
    const started = await driver.routes.request("/github?next=/r/abc");
    expect(started.status).toBe(302);
    const authorize = new URL(started.headers.get("location")!);
    expect(authorize.origin).toBe("https://github.test");
    expect(authorize.pathname).toBe("/login/oauth/authorize");

    // The callback exchanges the code, upserts the user and sets a cookie.
    const cookie = sessionCookie(await signIn(driver.routes));
    expect(cookie).not.toBe("");

    const signedIn = await driver.routes.request("/session", {
      headers: { cookie: `wb_session=${cookie}` },
    });

    expect(await signedIn.json()).toMatchObject({
      authenticated: true,
      user: { id: "gh:42", login: "ada", via: "github" },
    });

    // A forged state is rejected.
    expect(
      (
        await driver.routes.request(
          "/github/callback?code=abc&state=forged.state",
        )
      ).status,
    ).toBe(400);
  });

  it("binds the OAuth state to the browser through a nonce cookie", async () => {
    const { fetchImpl } = stubFetch({
      "/login/oauth/access_token": { body: { access_token: "gho_v" } },
      "/user": { body: { id: 9, login: "ada" } },
    });

    const driver = oauthDriver(fetchImpl);

    // Starting sign-in sets the short-lived nonce cookie.
    const started = await driver.routes.request("/github");
    const nonce = started.headers.get("set-cookie") ?? "";
    expect(nonce).toMatch(/wb_oauth_nonce=[^;]+;/);
    expect(nonce).toContain("HttpOnly");
    expect(nonce).toContain("SameSite=Lax");
    expect(nonce).toContain("Max-Age=600");

    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    )!;

    const callback = `/github/callback?code=c&state=${encodeURIComponent(state)}`;

    // Without the nonce cookie — or with another browser's — the signed state
    // alone does not finish the sign-in, and the cookie is cleared either way.
    const missing = await driver.routes.request(callback);
    expect(missing.status).toBe(400);
    expect(missing.headers.get("set-cookie")).toContain(
      "wb_oauth_nonce=; Path=/auth",
    );

    expect(
      (
        await driver.routes.request(callback, {
          headers: { cookie: "wb_oauth_nonce=someone-elses" },
        })
      ).status,
    ).toBe(400);
  });

  it("stores the session row under a hash, not the cookie value", async () => {
    const { fetchImpl } = stubFetch({
      "/login/oauth/access_token": { body: { access_token: "gho_v" } },
      "/user": { body: { id: 9, login: "ada" } },
    });

    const driver = oauthDriver(fetchImpl);
    const cookie = sessionCookie(await signIn(driver.routes));

    const row = await store.metadata.get("SELECT id FROM auth_sessions");
    expect(String(row?.id)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(row?.id)).not.toBe(cookie);

    // The raw cookie value still authenticates — the lookup hashes it.
    expect(
      await driver.authenticate(
        new Request("http://test/", {
          headers: { cookie: `wb_session=${cookie}` },
        }),
      ),
    ).toMatchObject({ login: "ada", via: "github" });
  });

  it("sets Secure and Max-Age on the session cookie for an https deployment", async () => {
    const { fetchImpl } = stubFetch({
      "/login/oauth/access_token": { body: { access_token: "gho_v" } },
      "/user": { body: { id: 9, login: "ada" } },
    });

    const driver = oauthDriver(fetchImpl);

    // The request URL is http (the test server), yet the configured https
    // GitHub URL keeps the Secure flag on — as behind a TLS-terminating proxy.
    const callback = await signIn(driver.routes);

    const session =
      callback.headers
        .get("set-cookie")
        ?.match(/wb_session=[^;]+;[^,]*/)?.[0] ?? "";

    expect(session).toContain("HttpOnly");
    expect(session).toContain("SameSite=Lax");
    expect(session).toContain("Secure");
    expect(session).toContain(`Max-Age=${(30 * 24 * 60 * 60_000) / 1000}`);
  });

  it("issues personal API tokens only to signed-in viewers", async () => {
    const { fetchImpl } = stubFetch({
      "/login/oauth/access_token": { body: { access_token: "gho_x" } },
      "/user": { body: { id: 7, login: "grace" } },
    });

    const driver = oauthDriver(fetchImpl);
    const cookie = sessionCookie(await signIn(driver.routes));

    const created = await driver.routes.request("/tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `wb_session=${cookie}`,
      },
      body: JSON.stringify({ name: "cli" }),
    });

    expect(created.status).toBe(201);
    const minted = (await created.json()) as { id: string; token: string };
    expect(minted.token.startsWith(API_TOKEN_PREFIX)).toBe(true);

    // The token authenticates as the user.
    expect(
      await driver.authenticate(
        new Request("http://test/", {
          headers: { authorization: `Bearer ${minted.token}` },
        }),
      ),
    ).toMatchObject({ id: "gh:7", login: "grace", via: "api-token" });

    // A token cannot mint further tokens.
    expect(
      (
        await driver.routes.request("/tokens", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${minted.token}`,
          },
          body: JSON.stringify({ name: "nested" }),
        })
      ).status,
    ).toBe(401);

    // Revocation is immediate.
    expect(
      (
        await driver.routes.request(`/tokens/${minted.id}`, {
          method: "DELETE",
          headers: { cookie: `wb_session=${cookie}` },
        })
      ).status,
    ).toBe(200);
    expect(
      await driver.authenticate(
        new Request("http://test/", {
          headers: { authorization: `Bearer ${minted.token}` },
        }),
      ),
    ).toBeNull();
  });

  it("authenticates a trusted proxy header pair and rejects a wrong secret", async () => {
    const driver = oauthDriver(stubFetch({}).fetchImpl, {
      oauth: null,
      proxy: {
        header: "x-user-login",
        secret: "proxy-secret",
        secretHeader: "x-proxy-proof",
      },
    });

    expect(
      await driver.authenticate(
        new Request("http://test/", {
          headers: {
            "x-user-login": "ada",
            "x-proxy-proof": "proxy-secret",
          },
        }),
      ),
    ).toMatchObject({ login: "ada", via: "proxy" });

    expect(
      await driver.authenticate(
        new Request("http://test/", {
          headers: {
            "x-user-login": "ada",
            "x-proxy-proof": "wrong",
          },
        }),
      ),
    ).toBeNull();

    // The login header alone is never enough.
    expect(
      await driver.authenticate(
        new Request("http://test/", {
          headers: { "x-user-login": "ada" },
        }),
      ),
    ).toBeNull();
  });
});

describe("remote server wall", () => {
  const wall = async (driver: AuthDriver) => {
    const api = createReviewApi(
      store,
      undefined,
      undefined,
      undefined,
      () => ({ desktopAvailable: false, softwareMapEnabled: false }),
      () => false,
      async () => false,
      () => ({}),
      {},
      undefined,
      false,
      undefined,
      undefined,
      {
        authenticate: (request) => driver.authenticate(request),
        canReadRepo: (principal, repoPath) =>
          driver.access.canRead(principal, repoPath),
        normalizeRepoPath: (repoPath) => driver.access.normalize(repoPath),
      },
    );

    const app = createReviewServerApp({
      token: "server-token",
      instanceId: "test",
      serverId: store.serverId(),
      relay: new GlobalReviewDesktopVerbRelay(),
      deployment: publicDeploymentConfig({
        mode: "remote",
        db: "sqlite",
        blobs: "fs",
        repoSource: "github",
        jobs: "inline",
        auth: "oauth",
        authSecret: "test-auth-secret",
      }),
      auth: driver,
    });

    app.route("/reviews-api", api);

    return app;
  };

  it("leaves /health open and 401s API, MCP and viewer paths", async () => {
    const app = await wall(oauthDriver(stubFetch({}).fetchImpl));

    expect((await app.request("/health")).status).toBe(200);

    for (const path of [
      "/reviews-api",
      "/reviews-api/capabilities",
      "/mcp",
      "/control",
      "/r/abc",
    ]) {
      const denied = await app.request(path);
      expect(denied.status).toBe(401);
      expect(denied.headers.get("www-authenticate")).toContain("Bearer");
    }

    // A browser GET gets the sign-in page instead of JSON.
    const page = await app.request("/r/abc", {
      headers: { accept: "text/html" },
    });

    expect(page.status).toBe(401);
    expect(await page.text()).toContain("Sign in");

    // The local token is not part of remote authentication.
    expect(
      (
        await app.request("/reviews-api", {
          headers: { "x-review-token": "server-token" },
        })
      ).status,
    ).toBe(401);
  });

  it("filters the catalog and 404s reviews the caller cannot read", async () => {
    const { fetchImpl } = stubFetch({
      "/login/oauth/access_token": { body: { access_token: "gho_v" } },
      "/user": { body: { id: 9, login: "ada" } },
      "/repos/acme/widgets": { status: 200 },
      "/repos/acme/secret": { status: 404 },
    });

    const driver = oauthDriver(fetchImpl);
    const app = await wall(driver);

    // Two repositories: one readable, one hidden from this user.
    const open = await store.registerRemoteRepository(
      "https://github.test/acme/widgets",
    );

    const closed = await store.registerRemoteRepository(
      "https://github.test/acme/secret",
    );

    const visible = await store.execute({
      operation: {
        type: "create",
        title: "Widgets",
        target: {
          kind: "commits",
          repositoryId: open.id,
          base: "b",
          head: "h",
        },
      },
    });

    const hidden = await store.execute({
      operation: {
        type: "create",
        title: "Secret",
        target: {
          kind: "commits",
          repositoryId: closed.id,
          base: "b",
          head: "h",
        },
      },
    });

    const cookie = sessionCookie(await signIn(app, "/auth"));
    const auth = { cookie: `wb_session=${cookie}` };

    const catalog = (await (
      await app.request("/reviews-api", { headers: auth })
    ).json()) as { title: string }[];

    expect(catalog.map((entry) => entry.title)).toEqual(["Widgets"]);

    // The hidden review answers the same 404 as a missing one.
    expect(
      (
        await app.request(`/reviews-api/${hidden.reviewId}`, {
          headers: auth,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/reviews-api/${visible.reviewId}`, {
          headers: auth,
        })
      ).status,
    ).toBe(200);
  });
});
