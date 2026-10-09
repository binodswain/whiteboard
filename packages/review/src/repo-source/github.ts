import { type ExecFileException, execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
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
    async checkout({ repo, baseSha, headSha, persistentDir }) {
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

      const directory = persistentDir
        ? path.resolve(persistentDir)
        : await mkdtemp(path.join(tempRoot, "whiteboard-repo-"));

      const persistent = Boolean(persistentDir);
      await mkdir(directory, { recursive: true });

      const isInitialized = await stat(path.join(directory, ".git")).then(
        () => true,
        () => false,
      );

      try {
        let token: string | undefined;

        try {
          token = await (
            options.tokenProvider ?? (() => process.env.GH_TOKEN)
          )();
        } catch {
          throw new RepoSourceError(
            "GitHub credentials could not be obtained.",
            "FETCH_FAILED",
          );
        }

        const env: NodeJS.ProcessEnv = {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
        };

        if (token) {
          env.GIT_CONFIG_COUNT = "1";
          env.GIT_CONFIG_KEY_0 = "http.extraHeader";
          env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
        }

        const git = async (...gitArgs: string[]) => {
          try {
            await exec("git", ["-C", directory, ...gitArgs], {
              env,
              maxBuffer: 8 * 1024 * 1024,
            });
          } catch {
            // Git's stderr may include transport details. Never expose it because
            // credential helpers and HTTP implementations can echo credentials.
            throw new RepoSourceError(
              `Unable to prepare a checkout from ${canonicalRepo}.`,
              "FETCH_FAILED",
            );
          }
        };

        if (!isInitialized) await git("init", "--quiet");
        const remote = options.remoteUrl?.(canonicalRepo) ?? canonicalRepo;

        if (isInitialized) await git("remote", "set-url", "origin", remote);
        else await git("remote", "add", "origin", remote);

        try {
          await exec(
            "git",
            [
              "-C",
              directory,
              "fetch",
              "--depth=1",
              "--filter=blob:none",
              "origin",
              baseSha,
              headSha,
            ],
            { env, maxBuffer: 8 * 1024 * 1024 },
          );
        } catch (error) {
          // SAFETY: execFile rejects with ExecFileException, which carries the child's stderr.
          const stderr = String((error as ExecFileException).stderr ?? "");

          if (
            /not our ref|could(?:n['’]t| not) find remote ref|server does not allow request for unadvertised object/i.test(
              stderr,
            )
          )
            throw new RepoSourceError(
              `GitHub does not have the requested commit. Make sure both SHAs are pushed to ${canonicalRepo}.`,
              "UNKNOWN_SHA",
            );

          throw new RepoSourceError(
            `Unable to fetch commits from ${canonicalRepo}. Check repository access and network connectivity.`,
            "FETCH_FAILED",
          );
        }

        await git("checkout", "--quiet", "--detach", headSha);

        return {
          dir: directory,
          async dispose() {
            if (!persistent)
              await rm(directory, { recursive: true, force: true });
          },
        };
      } catch (error) {
        if (!persistent) await rm(directory, { recursive: true, force: true });
        throw error;
      }
    },
  };
}
