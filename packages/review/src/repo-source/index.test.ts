import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createGitHubRepoSource } from "./github.js";

describe("GitHub repo source", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("fetches an old base SHA and checks out the requested head", async () => {
    const repo = await createBareRepo(tempDirs);
    const source = createGitHubRepoSource({ remoteUrl: () => repo.remote });

    const checkout = await source.checkout({
      repo: "https://github.com/example/project.git",
      baseSha: repo.baseSha,
      headSha: repo.headSha,
    });

    expect(await readFile(path.join(checkout.dir, "version.txt"), "utf8")).toBe(
      "head\n",
    );
    expect(git(checkout.dir, "rev-parse", "HEAD")).toBe(repo.headSha);
    await checkout.dispose();
    await expect(access(checkout.dir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("returns a push instruction for an unknown SHA and removes the temp checkout", async () => {
    const repo = await createBareRepo(tempDirs);

    const checkoutRoot = await mkdtemp(
      path.join(os.tmpdir(), "repo-source-parent-"),
    );

    tempDirs.push(checkoutRoot);

    const source = createGitHubRepoSource({
      cacheDir: checkoutRoot,
      remoteUrl: () => repo.remote,
    });

    await expect(
      source.checkout({
        repo: "https://github.com/example/project.git",
        baseSha: repo.baseSha,
        headSha: "0".repeat(40),
      }),
    ).rejects.toMatchObject({
      name: "RepoSourceError",
      code: "UNKNOWN_SHA",
      message: expect.stringMatching(/push/i),
    });
    await expect(readdir(checkoutRoot)).resolves.toEqual([]);
  });

  it("redacts tokens from fetch failure messages", async () => {
    const repo = await createBareRepo(tempDirs);
    const token = "secret-token-for-test";

    const source = createGitHubRepoSource({
      tokenProvider: async () => token,
      remoteUrl: () => path.join(os.tmpdir(), "does-not-exist.git"),
    });

    await expect(
      source.checkout({
        repo: "https://github.com/example/missing.git",
        baseSha: repo.baseSha,
        headSha: repo.headSha,
      }),
    ).rejects.toSatisfy(
      (error: Error & { code: string }) =>
        error.code === "FETCH_FAILED" &&
        !error.message.includes(token) &&
        !/push/i.test(error.message),
    );
  });

  it("does not expose credential-provider failures", async () => {
    const secret = "provider-error-secret";

    const source = createGitHubRepoSource({
      tokenProvider: async () => {
        throw new Error(secret);
      },
    });

    await expect(
      source.checkout({
        repo: "https://github.com/example/project.git",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      }),
    ).rejects.toSatisfy(
      (error: Error & { code: string }) =>
        error.code === "FETCH_FAILED" && !error.message.includes(secret),
    );
  });

  it("passes the token in Git's environment and keeps it out of argv", async () => {
    const repo = await createBareRepo(tempDirs);
    const token = "argv-secret-token";

    const wrapperDir = await mkdtemp(
      path.join(os.tmpdir(), "repo-source-git-"),
    );

    tempDirs.push(wrapperDir);
    const capture = path.join(wrapperDir, "argv.txt");
    const envCapture = path.join(wrapperDir, "env.txt");
    const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const wrapper = path.join(wrapperDir, "git");

    await writeFile(
      wrapper,
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GIT_ARGV_CAPTURE"\nprintf \'%s\\n\' "$GIT_CONFIG_COUNT|$GIT_CONFIG_KEY_0|$GIT_CONFIG_VALUE_0" >> "$GIT_ENV_CAPTURE"\nexec "$REAL_GIT" "$@"\n',
    );
    await chmod(wrapper, 0o755);
    vi.stubEnv("PATH", `${wrapperDir}:${process.env.PATH}`);
    vi.stubEnv("GIT_ARGV_CAPTURE", capture);
    vi.stubEnv("GIT_ENV_CAPTURE", envCapture);
    vi.stubEnv("REAL_GIT", gitPath);

    const checkout = await createGitHubRepoSource({
      tokenProvider: async () => token,
      remoteUrl: () => repo.remote,
    }).checkout({
      repo: "https://github.com/example/project.git",
      baseSha: repo.baseSha,
      headSha: repo.headSha,
    });

    await checkout.dispose();

    const capturedArgs = await readFile(capture, "utf8");

    const encodedToken = Buffer.from(`x-access-token:${token}`).toString(
      "base64",
    );

    expect(capturedArgs).not.toContain(token);
    expect(capturedArgs).not.toContain(encodedToken);
    expect(capturedArgs).not.toContain("http.extraHeader");
    expect(await readFile(envCapture, "utf8")).toContain(
      `1|http.extraHeader|AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    );
  });

  it("reports an unreachable remote as a fetch failure, not an unknown SHA", async () => {
    const repo = await createBareRepo(tempDirs);

    const source = createGitHubRepoSource({
      remoteUrl: () => path.join(os.tmpdir(), "unreachable-repo-source.git"),
    });

    await expect(
      source.checkout({
        repo: "https://github.com/example/unreachable.git",
        baseSha: repo.baseSha,
        headSha: repo.headSha,
      }),
    ).rejects.toMatchObject({
      code: "FETCH_FAILED",
      message: expect.not.stringMatching(/push/i),
    });
  });
});

async function createBareRepo(tempDirs: string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-source-test-"));
  tempDirs.push(root);
  const working = path.join(root, "working");
  const remote = path.join(root, "origin.git");
  execFileSync("git", ["init", "--bare", remote]);
  execFileSync("git", ["init", working]);
  execFileSync("git", [
    "-C",
    working,
    "config",
    "user.email",
    "test@example.com",
  ]);
  execFileSync("git", ["-C", working, "config", "user.name", "Test"]);
  await writeFile(path.join(working, "version.txt"), "base\n");
  execFileSync("git", ["-C", working, "add", "version.txt"]);
  execFileSync("git", ["-C", working, "commit", "-m", "base"]);
  const baseSha = git(working, "rev-parse", "HEAD");
  await writeFile(path.join(working, "version.txt"), "head\n");
  execFileSync("git", ["-C", working, "commit", "-am", "head"]);
  const headSha = git(working, "rev-parse", "HEAD");
  execFileSync("git", ["-C", working, "remote", "add", "origin", remote]);
  execFileSync("git", ["-C", working, "push", "origin", "HEAD"]);

  return { remote: `file://${remote}`, baseSha, headSha };
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
