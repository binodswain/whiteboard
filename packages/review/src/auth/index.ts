import type { MetadataStore } from "@review/review-api/storage/metadata-store.js";
import type { DeploymentConfig } from "@review/server/deployment-config.js";
import type { Hono } from "hono";

import { createOAuthDriver } from "./oauth.js";

/** Who a request is. The OAuth driver mints these from a GitHub sign-in, a
 * personal API token, or a trusted upstream proxy header. */
export interface AuthPrincipal {
  /** Stable internal user id — `gh:<github id>` or `proxy:<login>`. */
  id: string;
  login: string;
  via: "github" | "api-token" | "proxy" | "job";
  /** Canonical GitHub repository for an in-process queued job principal. */
  jobRepository?: string;
  /** Exact ephemeral clone owned by the same in-process queued job. */
  jobCheckoutPath?: string;
  /** The user's GitHub access token, when the sign-in supplied one. */
  githubToken?: string;
}

/**
 * The hosted-mode authentication driver: who the caller is, whether the
 * viewer itself is gated, which request headers downstream API calls should
 * forward, and the routes that mint sessions and personal API tokens.
 *
 * `kind === "local"` is never built — local mode keeps its existing token
 * wall in `createReviewServerApp`; this driver only exists for remote auth.
 */
export interface AuthDriver {
  kind: "oauth";
  authenticate(request: Request): Promise<AuthPrincipal | null>;
  /** Headers an internal (MCP) API call forwards from its caller. */
  forwardHeaders: string[];
  /** The sign-in and token-management routes, mounted at `/auth`. */
  routes: Hono;
  /** The viewer requires sign-in, so its pages are gated too. */
  viewerAuth: true;
  /** An HTML sign-in page for a GET that accepted HTML but is not signed in. */
  signInPage(next: string): string;
  /** Repository read access for a principal, checked against GitHub. */
  access: RepoAccess;
}

/** Repository read access for one principal; results are cached per user. */
export interface RepoAccess {
  canRead(principal: AuthPrincipal, repoPath: string): Promise<boolean>;
  /** The canonical remote URL a `repositoryPath` input names, or undefined
   * when it is not a GitHub remote (a local path in a local deployment). */
  normalize(repoPath: string): string | undefined;
}

/** A queued worker's in-process identity can read only the repository named
 * when the owner submitted that job. User principals retain GitHub checks. */
export function canReadRepository(
  principal: AuthPrincipal,
  repoPath: string,
  access: RepoAccess,
): Promise<boolean> {
  if (principal.via === "job")
    return Promise.resolve(
      Boolean(
        (principal.jobCheckoutPath && principal.jobCheckoutPath === repoPath) ||
        (principal.jobRepository &&
          principal.jobRepository === access.normalize(repoPath)),
      ),
    );

  return access.canRead(principal, repoPath);
}

/**
 * Builds the remote auth driver when the deployment asks for one — `null`
 * otherwise, so local mode keeps its existing token wall untouched.
 */
export function createAuthDriver(input: {
  deployment: DeploymentConfig;
  meta: MetadataStore;
  fetchImpl?: typeof fetch;
}): AuthDriver | null {
  const { deployment } = input;

  if (deployment.auth !== "oauth") return null;

  const requireSetting = (value: string | undefined, setting: string) => {
    if (!value) throw new Error(`Remote auth requires ${setting}`);

    return value;
  };

  if (!deployment.oauth && !deployment.proxy)
    throw new Error(
      "Remote auth requires GITHUB_OAUTH_CLIENT_ID/SECRET or " +
        "WHITEBOARD_AUTH_PROXY_HEADER/SECRET",
    );

  const webUrl = deployment.github?.webUrl ?? "https://github.com";
  const apiUrl = deployment.github?.apiUrl ?? "https://api.github.com";

  return createOAuthDriver({
    meta: input.meta,
    secret: requireSetting(deployment.authSecret, "WHITEBOARD_AUTH_SECRET"),
    oauth: deployment.oauth,
    proxy: deployment.proxy,
    githubApp: deployment.githubApp,
    webUrl,
    apiUrl,
    fetchImpl: input.fetchImpl,
  });
}
