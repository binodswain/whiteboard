import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { defaultBranch, mergeBase } from "@dev.fast/local-vcs";

const exec = promisify(execFile);

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface PreflightTarget {
  commit?: string;
  range?: string;
  branch?: string;
  pick?: string;
}

export interface ReviewTarget {
  baseSha: string;
  headSha: string;
}

export interface RecentCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
}

export interface PushStatus {
  upstream: string | null;
  unpushed: number;
}

export type PreflightIssue =
  | { kind: "dirty"; files: string[]; message: string }
  | { kind: "unpushed"; count: number; message: string };

export interface PreflightResult {
  errors: PreflightIssue[];
}

async function gitRaw(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", dir, ...args], {
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });

  return stdout;
}

async function git(dir: string, args: string[]): Promise<string> {
  return (await gitRaw(dir, args)).trim();
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

export async function checkWorkingTree(dir: string): Promise<string[]> {
  const output = await gitRaw(dir, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);

  const entries = output.split("\0").filter(Boolean);
  const files: string[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    files.push(entry.slice(3));

    // Renames and copies are followed by the original path as its own entry.
    if (/[RC]/.test(entry.slice(0, 2))) index += 1;
  }

  return files;
}

export async function checkPushed(dir: string): Promise<PushStatus> {
  const upstream = await git(dir, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]).catch(() => null);

  const range = upstream ? ["@{u}..HEAD"] : ["HEAD", "--not", "--remotes"];
  const count = await git(dir, ["rev-list", "--count", ...range]);

  return { upstream, unpushed: Number(count) };
}

export async function listRecentCommits(
  dir: string,
  n: number,
): Promise<RecentCommit[]> {
  const output = await git(dir, [
    "log",
    `--max-count=${n}`,
    "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI",
  ]);

  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, shortSha, subject, author, date] = line.split("\x1f");

      return { sha, shortSha, subject, author, date };
    });
}

async function commitSha(dir: string, ref: string): Promise<string> {
  const sha = await git(dir, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]).catch(() => null);

  if (!sha) throw new Error(`Not a commit: ${ref}`);

  return sha;
}

async function defaultBranchMergeBase(
  dir: string,
  headRef: string,
): Promise<string> {
  const branch = await defaultBranch(dir);

  if (!branch)
    throw new Error("No default branch found; use --commit or --range.");

  const base = await mergeBase({
    rootPath: dir,
    baseRef: branch.ref,
    headRef,
  });

  if (!base)
    throw new Error(`${headRef} shares no history with ${branch.ref}.`);

  return base.commit;
}

async function resolveRange(dir: string, range: string): Promise<ReviewTarget> {
  const separator = range.includes("...") ? "..." : "..";
  const parts = range.split(separator);

  if (parts.length !== 2)
    throw new Error(`Range must look like a..b, got: ${range}`);

  const [left, right] = parts.map((part) => part || "HEAD");
  const headSha = await commitSha(dir, right);

  if (separator === "...") {
    return {
      baseSha: await git(dir, ["merge-base", left, right]),
      headSha,
    };
  }

  return { baseSha: await commitSha(dir, left), headSha };
}

async function resolveCommit(dir: string, ref: string): Promise<ReviewTarget> {
  const headSha = await commitSha(dir, ref);
  const parents = await git(dir, ["rev-list", "--parents", "-n", "1", headSha]);
  const [, firstParent] = parents.split(" ");

  if (!firstParent)
    throw new Error(`Commit ${headSha} has no parent to review against.`);

  return { baseSha: firstParent, headSha };
}

export async function resolveTarget(
  dir: string,
  target: PreflightTarget,
): Promise<ReviewTarget> {
  const selected = [
    target.commit,
    target.range,
    target.branch,
    target.pick,
  ].filter((value) => value !== undefined);

  if (selected.length > 1)
    throw new Error("Choose one of commit, range, branch or pick.");

  if (target.commit !== undefined) return resolveCommit(dir, target.commit);

  if (target.pick !== undefined) return resolveCommit(dir, target.pick);

  if (target.range !== undefined) return resolveRange(dir, target.range);

  if (target.branch !== undefined) {
    const headSha = await commitSha(dir, target.branch);

    return {
      baseSha: await defaultBranchMergeBase(dir, target.branch),
      headSha,
    };
  }

  return {
    baseSha: await defaultBranchMergeBase(dir, "HEAD"),
    headSha: await commitSha(dir, "HEAD"),
  };
}

export async function preflight(
  dir: string,
  options: { remote: boolean },
): Promise<PreflightResult> {
  if (!options.remote) return { errors: [] };

  const errors: PreflightIssue[] = [];
  const files = await checkWorkingTree(dir);

  if (files.length > 0)
    errors.push({
      kind: "dirty",
      files,
      message: `Commit your changes and push: ${files.length} uncommitted ${plural(files.length, "file")} (${files.join(", ")})`,
    });

  const { upstream, unpushed } = await checkPushed(dir);

  if (unpushed > 0)
    errors.push({
      kind: "unpushed",
      count: unpushed,
      message: `push first: ${unpushed} ${plural(unpushed, "commit")} ${upstream ? `not on ${upstream}` : "not on any remote branch (no upstream set)"}`,
    });

  return { errors };
}
