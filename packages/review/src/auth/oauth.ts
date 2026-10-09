import { AsyncLocalStorage } from "node:async_hooks";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { MetadataStore } from "@review/review-api/storage/metadata-store.js";
import { readBoundedRequestJson } from "@review/server/hono-http.js";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";

import type { AuthDriver, AuthPrincipal } from "./index.js";
import { createGitHubAppCredentials, createRepoAccess } from "./repo-access.js";
import { createApiTokens } from "./tokens.js";

const SESSION_COOKIE = "wb_session";

/** Binds an OAuth sign-in to the browser that started it; single-use. */
const NONCE_COOKIE = "wb_oauth_nonce";

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

const OAUTH_STATE_TTL_MS = 10 * 60_000;

const createTokenSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
});

/** The request's credential fields as a browser or CLI sends them. */
const suppliedToken = (request: Request): string | null =>
  request.headers.get("x-review-token") ??
  request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ??
  new URL(request.url).searchParams.get("token");

const cookies = (request: Request): Map<string, string> => {
  const parsed = new Map<string, string>();

  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");

    if (name) parsed.set(name, decodeURIComponent(rest.join("=")));
  }

  return parsed;
};

/** A redirect target that stays on this origin. */
const safeNext = (next: string | undefined): string =>
  next?.startsWith("/") && !next.startsWith("//") ? next : "/";

/**
 * Remote authentication: GitHub OAuth sessions for the viewer, personal API
 * tokens for CLI/MCP, or a trusted upstream proxy's verified identity header.
 * Everything is keyed by `secret`; the database stores only sealed GitHub
 * tokens and hashed API tokens.
 */
export function createOAuthDriver(input: {
  meta: MetadataStore;
  secret: string;
  oauth?: { clientId: string; clientSecret: string };
  proxy?: { header: string; secret: string; secretHeader: string };
  githubApp?: { appId: string; privateKey: string; installationId?: string };
  webUrl: string;
  apiUrl: string;
  fetchImpl?: typeof fetch;
}): AuthDriver {
  const { meta, secret, oauth, proxy, webUrl, apiUrl } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const tokens = createApiTokens(meta);

  // Behind a TLS-terminating proxy the request URL reads http, so the Secure
  // flag cannot come from it; the configured GitHub URL stands in — remote
  // deployments are https in practice, so Secure is the default.
  const secureFlag = new URL(webUrl).protocol === "https:" ? "; Secure" : "";

  const clearNonceCookie = `${NONCE_COOKIE}=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`;

  // The cookie carries the raw session id; the row stores only its
  // domain-separated hash so a database leak does not yield live sessions.
  const hashSession = (id: string) =>
    createHash("sha256").update(`whiteboard:session:${id}`).digest("hex");

  // The GitHub OAuth token is the user's proof of repository access; it is
  // sealed at rest so a database dump alone cannot spend it.
  const sealKey = createHash("sha256")
    .update(`${secret}:github-token`)
    .digest();

  const seal = (value: string): string => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", sealKey, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);

    return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${data.toString("base64")}`;
  };

  const unseal = (sealed: string): string | undefined => {
    const [iv, tag, data] = sealed
      .split(".")
      .map((part) => Buffer.from(part, "base64"));

    if (!iv?.length || !tag?.length || !data?.length) return undefined;

    try {
      const decipher = createDecipheriv("aes-256-gcm", sealKey, iv);
      decipher.setAuthTag(tag);

      return Buffer.concat([decipher.update(data), decipher.final()]).toString(
        "utf8",
      );
    } catch {
      return undefined;
    }
  };

  // OAuth state carries its own expiry, the post-sign-in destination and a
  // nonce the callback must read back from this browser's cookie — a signed
  // state alone does not prove the callback is the browser that signed in.
  const signState = (payload: {
    exp: number;
    next: string;
    nonce: string;
  }): string => {
    const data = Buffer.from(JSON.stringify(payload)).toString("base64url");

    const signature = createHmac("sha256", `${secret}:state`)
      .update(data)
      .digest("base64url");

    return `${data}.${signature}`;
  };

  const verifyState = (
    value: string,
  ): { next: string; nonce: string } | undefined => {
    const [data, signature] = value.split(".");

    const expected = createHmac("sha256", `${secret}:state`)
      .update(data ?? "")
      .digest("base64url");

    const a = Buffer.from(signature ?? "");
    const b = Buffer.from(expected);

    if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;

    try {
      const state = z
        .object({ exp: z.number(), next: z.string(), nonce: z.string() })
        .safeParse(
          JSON.parse(Buffer.from(data!, "base64url").toString("utf8")),
        );

      if (!state.success || state.data.exp < Date.now()) return undefined;

      return { next: safeNext(state.data.next), nonce: state.data.nonce };
    } catch {
      return undefined;
    }
  };

  const upsertUser = async (
    id: string,
    login: string,
    profile?: { name?: string; avatarUrl?: string; githubToken?: string },
  ) => {
    const now = new Date().toISOString();
    const githubToken = profile?.githubToken ? seal(profile.githubToken) : null;

    await meta.run(
      `INSERT INTO auth_users(id,login,name,avatar_url,github_token,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         login=excluded.login, name=excluded.name, avatar_url=excluded.avatar_url,
         github_token=COALESCE(excluded.github_token, auth_users.github_token),
         updated_at=excluded.updated_at`,
      id,
      login,
      profile?.name ?? null,
      profile?.avatarUrl ?? null,
      githubToken,
      now,
      now,
    );
  };

  const openSession = async (
    request: Request,
  ): Promise<AuthPrincipal | null> => {
    const sessionId = cookies(request).get(SESSION_COOKIE);

    if (!sessionId) return null;

    const hashed = hashSession(sessionId);

    const row = await meta.get(
      `SELECT s.expires_at, u.id AS user_id, u.login, u.github_token
       FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
       WHERE s.id=?`,
      hashed,
    );

    if (!row) return null;

    if (String(row.expires_at) <= new Date().toISOString()) {
      await meta
        .run("DELETE FROM auth_sessions WHERE id=?", hashed)
        .catch(() => {});

      return null;
    }

    return {
      id: String(row.user_id),
      login: String(row.login),
      via: "github",
      githubToken: row.github_token
        ? unseal(String(row.github_token))
        : undefined,
    };
  };

  const openProxy = async (request: Request): Promise<AuthPrincipal | null> => {
    if (!proxy) return null;

    const proof = request.headers.get(proxy.secretHeader);
    const login = request.headers.get(proxy.header);

    if (!proof || !login) return null;

    const a = Buffer.from(proof);
    const b = Buffer.from(proxy.secret);

    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    // A row must exist for the token-management UI to bind tokens to.
    const id = `proxy:${login}`;
    const existing = await meta.get("SELECT id FROM auth_users WHERE id=?", id);

    if (!existing) {
      const now = new Date().toISOString();
      await meta
        .run(
          "INSERT INTO auth_users(id,login,created_at,updated_at) VALUES(?,?,?,?)",
          id,
          login,
          now,
          now,
        )
        .catch(() => {});
    }

    return { id, login, via: "proxy" };
  };

  const authenticate = async (
    request: Request,
  ): Promise<AuthPrincipal | null> => {
    const supplied = suppliedToken(request);

    if (supplied) {
      // An explicit credential decides the caller on its own — a bad token
      // must not silently fall back to a session cookie.
      const userId = await tokens.authenticate(supplied);

      if (!userId) return null;

      const user = await meta.get(
        "SELECT login,github_token FROM auth_users WHERE id=?",
        userId,
      );

      return {
        id: userId,
        login: String(user?.login ?? userId),
        via: "api-token",
        githubToken: user?.github_token
          ? unseal(String(user.github_token))
          : undefined,
      };
    }

    return (await openSession(request)) ?? (await openProxy(request));
  };

  const signInPage = (next: string): string => {
    const target = safeNext(next);

    const action = oauth
      ? `<a class="button" href="/auth/github?next=${encodeURIComponent(target)}">Sign in with GitHub</a>`
      : `<p>Sign in through your team's access portal, then reload this page.</p>`;

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in — Whiteboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0f1117;color:#e6e6e6}
main{max-width:22rem;text-align:center}
.button{display:inline-block;background:#fff;color:#111;padding:.6rem 1.2rem;border-radius:.4rem;text-decoration:none;font-weight:600}
.note{opacity:.7;font-size:.9rem;margin-top:1.5rem}
</style></head><body><main>
<h1>Whiteboard</h1>
${action}
<p class="note">API and MCP access use a personal token from Settings after sign-in.</p>
</main></body></html>`;
  };

  const routes = new Hono();
  const scope = new AsyncLocalStorage<AuthPrincipal>();

  routes.get("/session", async (context) => {
    const principal = await authenticate(context.req.raw);

    if (!principal)
      return context.json({
        authenticated: false,
        signIn: oauth ? "/auth/github" : undefined,
      });

    return context.json({
      authenticated: true,
      user: { id: principal.id, login: principal.login, via: principal.via },
    });
  });

  routes.get("/sign-in", (context) =>
    context.html(signInPage(context.req.query("next") ?? "/")),
  );

  routes.post("/logout", async (context) => {
    const sessionId = cookies(context.req.raw).get(SESSION_COOKIE);

    if (sessionId)
      await meta
        .run("DELETE FROM auth_sessions WHERE id=?", hashSession(sessionId))
        .catch(() => {});

    context.header(
      "set-cookie",
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`,
    );

    return context.json({ ok: true });
  });

  if (oauth) {
    routes.get("/github", (context) => {
      const origin = new URL(context.req.url).origin;
      const nonce = randomBytes(16).toString("base64url");

      const state = signState({
        exp: Date.now() + OAUTH_STATE_TTL_MS,
        next: safeNext(context.req.query("next")),
        nonce,
      });

      context.header(
        "set-cookie",
        `${NONCE_COOKIE}=${nonce}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${OAUTH_STATE_TTL_MS / 1000}${secureFlag}`,
      );

      const callback = `${origin}/auth/github/callback`;

      const url =
        `${webUrl}/login/oauth/authorize` +
        `?client_id=${encodeURIComponent(oauth.clientId)}` +
        `&redirect_uri=${encodeURIComponent(callback)}` +
        `&scope=repo&state=${encodeURIComponent(state)}`;

      return context.redirect(url);
    });

    routes.get("/github/callback", async (context) => {
      const state = verifyState(context.req.query("state") ?? "");
      const code = context.req.query("code");

      // The nonce cookie is single-use whether the callback is valid or not.
      context.header("set-cookie", clearNonceCookie);

      const nonce = cookies(context.req.raw).get(NONCE_COOKIE);
      const a = Buffer.from(nonce ?? "");
      const b = Buffer.from(state?.nonce ?? "");

      if (!state || a.length !== b.length || !timingSafeEqual(a, b))
        return context.json({ error: "Invalid sign-in state." }, 400);

      if (!code) return context.json({ error: "Missing sign-in code." }, 400);

      const exchanged = await fetchImpl(`${webUrl}/login/oauth/access_token`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          client_id: oauth.clientId,
          client_secret: oauth.clientSecret,
          code,
        }),
      }).catch(() => undefined);

      const accessToken = exchanged
        ? z
            .object({ access_token: z.string() })
            .safeParse(await exchanged.json().catch(() => undefined))
        : undefined;

      if (!accessToken?.success)
        return context.json({ error: "GitHub sign-in failed." }, 502);

      const profile = await fetchImpl(`${apiUrl}/user`, {
        headers: {
          authorization: `Bearer ${accessToken.data.access_token}`,
          accept: "application/vnd.github+json",
          "user-agent": "whiteboard",
        },
      }).catch(() => undefined);

      const user = profile?.ok
        ? z
            .object({
              id: z.number(),
              login: z.string().min(1),
              name: z.string().optional(),
              avatar_url: z.string().optional(),
            })
            .safeParse(await profile.json().catch(() => undefined))
        : undefined;

      if (!user?.success)
        return context.json({ error: "GitHub sign-in failed." }, 502);

      const userId = `gh:${user.data.id}`;

      await upsertUser(userId, user.data.login, {
        name: user.data.name,
        avatarUrl: user.data.avatar_url,
        githubToken: accessToken.data.access_token,
      });

      const sessionId = randomBytes(32).toString("base64url");
      const now = Date.now();

      await meta.run(
        "INSERT INTO auth_sessions(id,user_id,created_at,expires_at) VALUES(?,?,?,?)",
        hashSession(sessionId),
        userId,
        new Date(now).toISOString(),
        new Date(now + SESSION_TTL_MS).toISOString(),
      );

      context.header(
        "set-cookie",
        `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secureFlag}`,
        { append: true },
      );

      return context.redirect(state.next);
    });
  }

  // Personal API tokens: a signed-in user (not another token) manages them.
  const requireUser: MiddlewareHandler = async (context, next) => {
    const principal = await authenticate(context.req.raw);

    if (!principal || principal.via === "api-token")
      return context.json({ error: "Unauthorized" }, 401);

    return scope.run(principal, next);
  };

  routes.use("/tokens", requireUser);
  routes.use("/tokens/*", requireUser);

  routes.get("/tokens", async (context) =>
    context.json({ tokens: await tokens.list(scope.getStore()!.id) }),
  );

  routes.post("/tokens", async (context) => {
    const parsed = createTokenSchema.safeParse(
      await readBoundedRequestJson(context.req.raw),
    );

    if (!parsed.success)
      return context.json({ error: "A token needs a name." }, 400);

    return context.json(
      await tokens.create(scope.getStore()!.id, parsed.data.name),
      201,
    );
  });

  routes.delete("/tokens/:id", async (context) => {
    const revoked = await tokens.revoke(
      scope.getStore()!.id,
      z.string().min(1).parse(context.req.param("id")),
    );

    return context.json({ ok: revoked }, revoked ? 200 : 404);
  });

  return {
    kind: "oauth",
    authenticate,
    forwardHeaders: [
      "x-review-token",
      "authorization",
      ...(proxy ? [proxy.header, proxy.secretHeader] : []),
    ],
    routes,
    viewerAuth: true,
    signInPage,
    access: createRepoAccess({
      meta,
      apiUrl,
      webUrl,
      app:
        input.githubApp &&
        createGitHubAppCredentials({
          app: input.githubApp,
          apiUrl,
          fetchImpl,
        }),
      fetchImpl,
    }),
  };
}
