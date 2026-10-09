import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { normalizeGitHubRemote } from "@dev.fast/review-share-protocol";

import { type RepoSource, RepoSourceError } from "./index.js";

const exec = promisify(execFile);

export type GitHubRepoSourceOptions = {
  /** Supplies a short-lived installation token; GH_TOKEN is used by default. */
  tokenProvider?: () => string | undefined | Promise<string | undefined>;
  /** Allows a host to provide disposable on-disk checkout storage. */
  cacheDir?: string;
  /** Internal transport override, useful for mirrors and local bare remotes. */
  remoteUrl?: (canonicalRepo: string) => string;
};

export function createGitHubRepoSource(
  options: GitHubRepoSourceOptions = {},
): RepoSource {
  return {
    async checkout({ repo, baseSha, headSha }) {
      let canonicalRepo: string;

      try {
        canonicalRepo = normalizeGitHubRemote(repo);
      } catch {
        throw new RepoSourceError(
          "Repository must identify a GitHub repository.",
          "INVALID_REPOSITORY",
        );
      }

      if (
        ![baseSha, headSha].every((sha) =>
          /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(sha),
        )
      )
        throw new RepoSourceError(
          "Review revisions must be full commit SHAs.",
          "UNKNOWN_SHA",
        );

      const tempRoot = options.cacheDir ?? os.tmpdir();
      await mkdir(tempRoot, { recursive: true });
      const directory = await mkdtemp(path.join(tempRoot, "whiteboard-repo-"));

      try {
        const token = await (
          options.tokenProvider ?? (() => process.env.GH_TOKEN)
        )();

        const args = token
          ? [
              "-c",
              `http.extraHeader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
            ]
          : [];

        const git = async (...gitArgs: string[]) => {
          try {
            await exec("git", [...args, "-C", directory, ...gitArgs], {
              env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
              maxBuffer: 8 * 1024 * 1024,
            });
          } catch {
            // Git's stderr may include transport details. Never expose it because
            // credential helpers and HTTP implementations can echo credentials.
            throw new RepoSourceError(
              `GitHub could not provide the requested commit. Make sure both SHAs are pushed to ${canonicalRepo}.`,
              "UNKNOWN_SHA",
            );
          }
        };

        await git("init", "--quiet");
        await git(
          "remote",
          "add",
          "origin",
          options.remoteUrl?.(canonicalRepo) ?? canonicalRepo,
        );
        await git(
          "fetch",
          "--depth=1",
          "--filter=blob:none",
          "origin",
          baseSha,
          headSha,
        );
        await git("checkout", "--quiet", "--detach", headSha);

        return {
          dir: directory,
          async dispose() {
            await rm(directory, { recursive: true, force: true });
          },
        };
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    },
  };
}
