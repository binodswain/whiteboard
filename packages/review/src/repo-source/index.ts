export type RepoCheckout = {
  dir: string;
  dispose(): Promise<void>;
};

export type RepoCheckoutRequest = {
  /** A local repository path or canonical GitHub repository remote. */
  repo: string;
  baseSha: string;
  headSha: string;
};

export interface RepoSource {
  checkout(request: RepoCheckoutRequest): Promise<RepoCheckout>;
}

export type RepoSourceErrorCode = "UNKNOWN_SHA" | "INVALID_REPOSITORY";

export class RepoSourceError extends Error {
  constructor(
    message: string,
    readonly code: RepoSourceErrorCode,
  ) {
    super(message);
    this.name = "RepoSourceError";
  }
}

export { createLocalRepoSource } from "./local.js";

export { createGitHubRepoSource } from "./github.js";
