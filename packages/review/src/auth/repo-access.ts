import { createSign } from "node:crypto";

import type { MetadataStore } from "@review/review-api/storage/metadata-store.js";

import type { AuthPrincipal, RepoAccess } from "./index.js";

/** How long a repo-access verdict is trusted before GitHub is asked again. */
const REPO_ACCESS_TTL_MS = 5 * 60_000;

const SLUG_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** `owner/repo` for a remote pointing at `webHost`, else undefined — so the
 * spellings remotes use (`https`, `ssh`, `git@`, `.git` suffixed, and the
 * bare `owner/repo` agents pass) all name one repository. */
export function githubRepoSlug(
  repoPath: string,
  webHost = "github.com",
): string | undefined {
  let candidate = repoPath.trim();

  // git@host:owner/repo — scp-style ssh.
  const scp = candidate.match(/^[^\s/]+@([^:]+):(.+)$/);

  if (scp) candidate = `https://${scp[1]}/${scp[2]}`;
  else if (/^[\w.-]+\/[\w.-]+$/.test(candidate))
    candidate = `https://${webHost}/${candidate}`;

  let url: URL;

  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }

  if (url.hostname !== webHost) return undefined;

  const parts = url.pathname
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);

  if (
    parts.length !== 2 ||
    !parts.every(
      (part) => SLUG_SEGMENT.test(part) && part !== "." && part !== "..",
    )
  )
    return undefined;

  return `${parts[0]}/${parts[1]}`.toLowerCase();
}

interface GitHubApi {
  /** The endpoint's status (0 when the request never completed) and its
   * JSON body when it carried one. */
  get(
    route: string,
    authorization?: string,
  ): Promise<{ status: number; body: unknown }>;
  post(
    route: string,
    authorization: string,
  ): Promise<{ status: number; body: unknown }>;
}

function githubApi(apiUrl: string, fetchImpl: typeof fetch): GitHubApi {
  const send = async (
    method: string,
    route: string,
    authorization?: string,
  ) => {
    const headers = new Headers({
      accept: "application/vnd.github+json",
      "user-agent": "whiteboard",
    });

    if (authorization) headers.set("authorization", authorization);

    try {
      const response = await fetchImpl(`${apiUrl}${route}`, {
        method,
        headers,
      });

      const body = await response.json().catch(() => undefined);

      return { status: response.status, body };
    } catch {
      return { status: 0, body: undefined };
    }
  };

  return {
    get: (route, authorization) => send("GET", route, authorization),
    post: (route, authorization) => send("POST", route, authorization),
  };
}

/**
 * A GitHub App's server credentials: installation tokens minted per
 * repository (per hosted job), cached until just before they expire.
 */
export function createGitHubAppCredentials(input: {
  app: { appId: string; privateKey: string; installationId?: string };
  apiUrl: string;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const api = githubApi(input.apiUrl, fetchImpl);

  const b64u = (value: string | Buffer) =>
    Buffer.from(value).toString("base64url");

  const appJwt = () => {
    const now = Math.floor(Date.now() / 1000);

    const body = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64u(
      JSON.stringify({ iat: now - 60, exp: now + 540, iss: input.app.appId }),
    )}`;

    const signature = createSign("RSA-SHA256")
      .update(body)
      .sign(input.app.privateKey);

    return `${body}.${b64u(signature)}`;
  };

  // Repository slug → installation, and slug → live installation token.
  const installations = new Map<string, string>();
  const tokens = new Map<string, { token: string; expiresAt: number }>();

  return {
    /** An installation token that reads this repository — throws when the
     * App is not installed there. */
    async installationToken(slug: string): Promise<string> {
      const live = tokens.get(slug);

      if (live && live.expiresAt > Date.now() + 60_000) return live.token;

      let installationId = input.app.installationId ?? installations.get(slug);

      if (!installationId) {
        const found = await api.get(
          `/repos/${slug}/installation`,
          `Bearer ${appJwt()}`,
        );

        if (found.status !== 200)
          throw new Error(
            `GitHub App cannot see ${slug} (installation lookup ${found.status})`,
          );

        // SAFETY: the endpoint returned 200, so the body is the documented
        // installation object.
        installationId = String((found.body as { id: number | string }).id);
        installations.set(slug, installationId);
      }

      const minted = await api.post(
        `/app/installations/${installationId}/access_tokens`,
        `Bearer ${appJwt()}`,
      );

      if (minted.status !== 201)
        throw new Error(
          `GitHub App token mint failed for ${slug} (${minted.status})`,
        );

      // SAFETY: the endpoint returned 201, so the body is the documented
      // installation token object.
      const { token, expires_at } = minted.body as {
        token: string;
        expires_at: string;
      };

      tokens.set(slug, { token, expiresAt: Date.parse(expires_at) });

      return token;
    },
  };
}

export type GitHubAppCredentials = ReturnType<
  typeof createGitHubAppCredentials
>;

/**
 * Per-user repository access: a user's own GitHub token answers directly, a
 * proxy user's collaborator permission is checked through the App when one
 * is configured, and a public repository reads for any GitHub identity.
 * Verdicts are cached per user; transient failures are never cached.
 */
export function createRepoAccess(input: {
  meta: MetadataStore;
  apiUrl: string;
  webUrl: string;
  app?: GitHubAppCredentials;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
}): RepoAccess {
  const fetchImpl = input.fetchImpl ?? fetch;
  const webHost = new URL(input.webUrl).hostname;
  const api = githubApi(input.apiUrl, fetchImpl);
  const ttlMs = input.ttlMs ?? REPO_ACCESS_TTL_MS;

  /** true/false is a verdict GitHub gave; undefined is transient — the
   * caller denies but must not cache it. */
  const verify = async (
    principal: AuthPrincipal,
    slug: string,
  ): Promise<boolean | undefined> => {
    if (principal.githubToken) {
      const { status } = await api.get(
        `/repos/${slug}`,
        `Bearer ${principal.githubToken}`,
      );

      if (status === 200) return true;

      // 403/404 is the repo's answer to this user; 401 is an expired token —
      // not an access verdict.
      if (status === 403 || status === 404) return false;

      if (status === 401) return undefined;
    }

    if (input.app) {
      try {
        const token = await input.app.installationToken(slug);

        const { status, body } = await api.get(
          `/repos/${slug}/collaborators/${encodeURIComponent(principal.login)}/permission`,
          `Bearer ${token}`,
        );

        if (status === 200) {
          // SAFETY: the endpoint returned 200, so the body is the documented
          // collaborator permission object.
          const permission = (body as { permission?: string }).permission;

          return permission !== "none" && permission !== undefined;
        }

        if (status !== 403 && status !== 404) return undefined;
      } catch {
        // Not in the App's installation — the public check below may still
        // name it readable.
      }
    }

    // Public repositories read for any GitHub identity, which is all a proxy
    // login asserts. 404 covers both private and missing: deny.
    const { status } = await api.get(`/repos/${slug}`);

    if (status === 200) return true;

    if (status === 403 || status === 404) return false;

    return undefined;
  };

  return {
    normalize(repoPath: string) {
      const slug = githubRepoSlug(repoPath, webHost);

      return slug ? `${input.webUrl}/${slug}` : undefined;
    },

    async canRead(principal: AuthPrincipal, repoPath: string) {
      const slug = githubRepoSlug(repoPath, webHost);

      if (!slug) return false;

      const cutoff = new Date(Date.now() - ttlMs).toISOString();

      const cached = await input.meta.get(
        `SELECT allowed FROM auth_repo_access
         WHERE user_id=? AND repo=? AND checked_at>?`,
        principal.id,
        slug,
        cutoff,
      );

      if (cached) return Boolean(Number(cached.allowed));

      const allowed = await verify(principal, slug);

      if (allowed === undefined) return false;

      await input.meta.run(
        `INSERT INTO auth_repo_access(user_id,repo,allowed,checked_at)
         VALUES(?,?,?,?)
         ON CONFLICT(user_id,repo)
         DO UPDATE SET allowed=excluded.allowed,checked_at=excluded.checked_at`,
        principal.id,
        slug,
        allowed ? 1 : 0,
        new Date().toISOString(),
      );

      return allowed;
    },
  };
}
