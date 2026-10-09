import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkPushed,
  checkWorkingTree,
  listRecentCommits,
  preflight,
  resolveTarget,
} from "./preflight";
import { cleanupTempDirs, gitRepository, tempDir } from "./review-test-utils";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

async function commitFile(
  repo: string,
  name: string,
  message: string,
): Promise<string> {
  await writeFile(path.join(repo, name), `${message}\n`, "utf8");
  git(repo, "add", name);
  git(repo, "commit", "-m", message);

  return git(repo, "rev-parse", "HEAD");
}

async function repoWithOrigin(): Promise<string> {
  const remote = await tempDir("preflight-remote-");
  git(remote, "init", "--bare", "-b", "main");

  const repo = await gitRepository();
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");

  return repo;
}

describe("preflight", () => {
  afterEach(cleanupTempDirs);

  it("checkWorkingTree is empty for a clean repository", async () => {
    const repo = await gitRepository();

    expect(await checkWorkingTree(repo)).toEqual([]);
  });

  it("checkWorkingTree lists modified tracked files", async () => {
    const repo = await gitRepository();
    await writeFile(path.join(repo, "README.md"), "changed\n", "utf8");

    expect(await checkWorkingTree(repo)).toEqual(["README.md"]);
  });

  it("checkWorkingTree lists untracked files", async () => {
    const repo = await gitRepository();
    await writeFile(path.join(repo, "notes.txt"), "draft\n", "utf8");

    expect(await checkWorkingTree(repo)).toEqual(["notes.txt"]);
  });

  it("checkPushed reports no unpushed commits when the branch matches its upstream", async () => {
    const repo = await repoWithOrigin();

    expect(await checkPushed(repo)).toEqual({
      upstream: "origin/main",
      unpushed: 0,
    });
  });

  it("checkPushed counts local commits ahead of the upstream", async () => {
    const repo = await repoWithOrigin();
    await commitFile(repo, "a.txt", "first");
    await commitFile(repo, "b.txt", "second");

    expect(await checkPushed(repo)).toEqual({
      upstream: "origin/main",
      unpushed: 2,
    });
  });

  it("checkPushed counts commits against remote branches when there is no upstream", async () => {
    const repo = await repoWithOrigin();
    git(repo, "checkout", "-b", "feature");
    await commitFile(repo, "a.txt", "first");
    await commitFile(repo, "b.txt", "second");

    expect(await checkPushed(repo)).toEqual({ upstream: null, unpushed: 2 });

    git(repo, "push", "origin", "feature");

    expect(await checkPushed(repo)).toEqual({ upstream: null, unpushed: 0 });
  });

  it("checkPushed counts every commit when no remote exists", async () => {
    const repo = await gitRepository();

    expect(await checkPushed(repo)).toEqual({ upstream: null, unpushed: 1 });
  });

  it("listRecentCommits returns the newest commits first", async () => {
    const repo = await gitRepository();
    await commitFile(repo, "a.txt", "one");
    await commitFile(repo, "b.txt", "two");
    const newest = await commitFile(repo, "c.txt", "three");

    const commits = await listRecentCommits(repo, 2);

    expect(commits.map((commit) => commit.subject)).toEqual(["three", "two"]);
    expect(commits[0]).toMatchObject({
      sha: newest,
      shortSha: newest.slice(0, 7),
      author: "Review Test",
    });
  });

  describe("resolveTarget", () => {
    async function featureRepo() {
      const repo = await gitRepository();
      const initial = git(repo, "rev-parse", "HEAD");

      git(repo, "checkout", "-b", "feature");
      const f1 = await commitFile(repo, "f1.txt", "feature one");
      const f2 = await commitFile(repo, "f2.txt", "feature two");

      git(repo, "checkout", "main");
      const m1 = await commitFile(repo, "m1.txt", "main moved on");

      git(repo, "checkout", "feature");

      return { repo, initial, f1, f2, m1 };
    }

    it("defaults to the merge-base with the default branch through HEAD", async () => {
      const { repo, initial, f2 } = await featureRepo();

      expect(await resolveTarget(repo, {})).toEqual({
        baseSha: initial,
        headSha: f2,
      });
    });

    it("reviews a single commit against its parent", async () => {
      const { repo, f1, f2 } = await featureRepo();

      expect(await resolveTarget(repo, { commit: f2 })).toEqual({
        baseSha: f1,
        headSha: f2,
      });
    });

    it("reviews a two-dot range from its left side to its right side", async () => {
      const { repo, f1, f2, m1 } = await featureRepo();

      expect(await resolveTarget(repo, { range: `${f1}..${f2}` })).toEqual({
        baseSha: f1,
        headSha: f2,
      });
      expect(await resolveTarget(repo, { range: `${m1}..${f2}` })).toEqual({
        baseSha: m1,
        headSha: f2,
      });
    });

    it("uses the merge-base for a three-dot range", async () => {
      const { repo, initial, f2, m1 } = await featureRepo();

      expect(await resolveTarget(repo, { range: `${m1}...${f2}` })).toEqual({
        baseSha: initial,
        headSha: f2,
      });
    });

    it("reviews a branch against its merge-base with the default branch", async () => {
      const { repo, initial, f2 } = await featureRepo();
      git(repo, "checkout", "main");

      expect(await resolveTarget(repo, { branch: "feature" })).toEqual({
        baseSha: initial,
        headSha: f2,
      });
    });

    it("reviews a commit picked from the recent list", async () => {
      const { repo, f1 } = await featureRepo();
      const [latest] = await listRecentCommits(repo, 1);

      expect(await resolveTarget(repo, { pick: latest.sha })).toEqual({
        baseSha: f1,
        headSha: latest.sha,
      });
    });

    it("rejects more than one target option", async () => {
      const { repo, f2 } = await featureRepo();

      await expect(
        resolveTarget(repo, { commit: f2, branch: "feature" }),
      ).rejects.toThrow("Choose one of");
    });
  });

  describe("preflight", () => {
    it("returns no blocking errors in local mode", async () => {
      const repo = await repoWithOrigin();
      await commitFile(repo, "a.txt", "unpushed");
      await writeFile(path.join(repo, "dirty.txt"), "dirty\n", "utf8");

      expect(await preflight(repo, { remote: false })).toEqual({ errors: [] });
    });

    it("passes in remote mode when the tree is clean and pushed", async () => {
      const repo = await repoWithOrigin();

      expect(await preflight(repo, { remote: true })).toEqual({ errors: [] });
    });

    it("tells the user to commit and push dirty files in remote mode", async () => {
      const repo = await repoWithOrigin();
      await writeFile(path.join(repo, "README.md"), "changed\n", "utf8");
      await writeFile(path.join(repo, "notes.txt"), "draft\n", "utf8");

      const { errors } = await preflight(repo, { remote: true });

      expect(errors).toEqual([
        {
          kind: "dirty",
          files: ["README.md", "notes.txt"],
          message: expect.stringContaining("Commit your changes and push"),
        },
      ]);
      expect(errors[0].message).toContain("README.md, notes.txt");
    });

    it("asks for a push with the unpushed commit count in remote mode", async () => {
      const repo = await repoWithOrigin();
      await commitFile(repo, "a.txt", "first");
      await commitFile(repo, "b.txt", "second");

      const { errors } = await preflight(repo, { remote: true });

      expect(errors).toEqual([
        {
          kind: "unpushed",
          count: 2,
          message: "push first: 2 commits not on origin/main",
        },
      ]);
    });

    it("explains a missing upstream in remote mode", async () => {
      const repo = await repoWithOrigin();
      git(repo, "checkout", "-b", "feature");
      await commitFile(repo, "a.txt", "first");

      const { errors } = await preflight(repo, { remote: true });

      expect(errors).toEqual([
        {
          kind: "unpushed",
          count: 1,
          message:
            "push first: 1 commit not on any remote branch (no upstream set)",
        },
      ]);
    });
  });
});
