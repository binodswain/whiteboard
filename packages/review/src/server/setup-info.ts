import { readReviewPackageVersion } from "@review/package-paths.js";
import { isLocalAuthRequest } from "@review/review-api/http.js";

import type { publicDeploymentConfig } from "./deployment-config.js";
import { isAuthorizedRequest, jsonResponse } from "./hono-http.js";

const version = readReviewPackageVersion(import.meta.url);

/** What `GET /setup-info` answers: how a host-side agent reaches this server. */
export interface SetupInfo {
  serverUrl: string;
  /** The host directory the container serves; null when CODE_ROOT is unset. */
  codeRoot: string | null;
  /** Local browser auth is on: the canvas needs no token. */
  localAuth: boolean;
  /** Present only to a caller already allowed to know it. */
  token?: string;
  version: string;
  healthy: boolean;
  deployment: ReturnType<typeof publicDeploymentConfig>;
}

/**
 * The /setup page's one read. It is public like /health — it exists to teach
 * an agent how to connect — but the token goes out only when local auth is
 * off and the request already holds it or passes the same Host/Origin check
 * the local browser auth uses: a loopback page's fetch gets the token, a
 * cross-origin or DNS-rebinding page's does not.
 */
export function createSetupInfoHandler(input: {
  token: string;
  localBrowserAuth?: boolean;
  localBrowserPort?: () => number | undefined;
  deployment: ReturnType<typeof publicDeploymentConfig>;
}): (request: Request) => Response {
  return (request) => {
    const localAuth = input.localBrowserAuth === true;

    const revealToken =
      !localAuth &&
      (isAuthorizedRequest(request, input.token) ||
        isLocalAuthRequest(request, input.localBrowserPort?.()));

    const info: SetupInfo = {
      serverUrl: new URL(request.url).origin,
      codeRoot: process.env.CODE_ROOT?.trim() || null,
      localAuth,
      version,
      healthy: true,
      deployment: input.deployment,
    };

    if (revealToken) info.token = input.token;

    return jsonResponse(info, 200, { cacheControl: "no-store" });
  };
}
