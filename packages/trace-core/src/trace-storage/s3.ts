import { readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { type JsonValue, parseJsonText } from "@dev.fast/json";
import {
  type ByCommitEntry,
  type SessionMeta,
  byCommitSchema,
  commitShaSchema,
  sessionMetaSchema,
} from "@dev.fast/trace-protocol";

import { S3ObjectClient } from "./s3-client";
import {
  type S3ConfigScope,
  type S3Credentials,
  isS3MockMode,
  resolveS3Credentials,
  s3CacheIdentity,
  s3MockRoot,
} from "./s3-config";
import type {
  S3StorageTarget,
  TraceCommitAssociation,
  TraceCommitSessions,
  TraceObjectInfo,
  TracePublishInput,
  TracePublishResult,
  TracePublishUpload,
  TraceStorage,
  TraceStorageReadiness,
} from "./types";

/**
 * Direct S3/R2 storage through the AWS CLI. Owns the legacy bucket layout:
 *
 *   by-session/<session>/trace.jsonl
 *   by-session/<session>/subagents/<name>.jsonl
 *   by-session/<session>/meta.json
 *   by-commit/<sha>.json
 *
 * Objects only grow: a transcript is re-uploaded when the local copy is
 * larger than the stored one, and a by-commit entry is written once.
 */
export class S3TraceStorage implements TraceStorage {
  readonly kind = "s3" as const;
  readonly target: S3StorageTarget;
  private readonly objects: S3ObjectClient;

  private constructor(
    private readonly config: S3Credentials | null,
    private readonly mockRoot: string | null,
    env: NodeJS.ProcessEnv,
  ) {
    this.objects = new S3ObjectClient(config, mockRoot, env);
    this.target = config
      ? {
          kind: "s3",
          endpoint: config.endpoint,
          bucket: config.bucket,
          region: config.region,
        }
      : {
          kind: "s3",
          endpoint: "mock://endpoint",
          bucket: "mock-bucket",
          region: "auto",
          mockRoot: mockRoot ?? undefined,
        };
  }

  /**
   * The bucket named by the legacy configuration, or null when none is
   * configured. Mock mode yields a storage backed by a directory.
   */
  static fromEnvironment(scope: S3ConfigScope = {}): S3TraceStorage | null {
    const env = scope.env ?? process.env;

    if (isS3MockMode(env)) {
      return new S3TraceStorage(null, s3MockRoot(env), env);
    }

    const config = resolveS3Credentials(scope);

    return config ? new S3TraceStorage(config, null, env) : null;
  }

  static fromCredentials(
    config: S3Credentials,
    env: NodeJS.ProcessEnv = process.env,
  ): S3TraceStorage {
    return new S3TraceStorage(config, null, env);
  }

  /** Secret-free identity of the destination; the same bucket keys the same cache. */
  cacheIdentity(): string {
    return s3CacheIdentity(this.config, this.mockRoot);
  }

  cacheScope(
    repo: { owner: string; repo: string } | null,
  ): { owner: string; repo: string } | null {
    return repo;
  }

  /** A non-mutating reachability check of the configured bucket. */
  async readiness(): Promise<TraceStorageReadiness> {
    return this.objects.readiness();
  }

  async describeObject(
    sessionId: string,
    traceName: string,
  ): Promise<TraceObjectInfo | null> {
    const size = await this.objects.headObjectSize(
      objectKey(sessionId, traceName),
    );

    return size === null ? null : { size, contentId: `size:${size}` };
  }

  async downloadObject(
    sessionId: string,
    traceName: string,
    destinationPath: string,
  ): Promise<TraceObjectInfo | null> {
    if (
      !(await this.objects.getObject(
        objectKey(sessionId, traceName),
        destinationPath,
      ))
    ) {
      return null;
    }

    const size = statSync(destinationPath).size;

    return { size, contentId: `size:${size}` };
  }

  async listSubagents(sessionId: string): Promise<string[]> {
    const prefix = `by-session/${sessionId}/subagents/`;
    const names = new Set<string>();

    for (const key of await this.objects.listKeys(prefix)) {
      if (key.startsWith(prefix) && key.endsWith(".jsonl")) {
        const name = key.slice(prefix.length, -6);

        if (name) names.add(name);
      }
    }

    return [...names].sort();
  }

  async sessionMeta(sessionId: string): Promise<SessionMeta | null> {
    try {
      const parsed = sessionMetaSchema.safeParse(
        await this.getJson(metaKey(sessionId)),
      );

      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async sessionsForCommit(commit: string): Promise<TraceCommitSessions | null> {
    if (!commitShaSchema.safeParse(commit).success) return null;

    try {
      const parsed = byCommitSchema.safeParse(
        await this.getJson(commitKey(commit)),
      );

      if (!parsed.success || parsed.data.sessions.length === 0) return null;

      return {
        sessions: parsed.data.sessions,
        pr: parsed.data.pr,
        branch: parsed.data.branch,
      };
    } catch {
      return null;
    }
  }

  async publish(input: TracePublishInput): Promise<TracePublishResult> {
    const uploads: TracePublishUpload[] = [];

    for (const file of input.files) {
      const key = objectKey(input.sessionId, file.name);
      const grown = await this.putIfGrown(key, file.path);
      uploads.push({
        blob: file.name === "main" ? "trace.jsonl" : `subagents/${file.name}`,
        bytes_stored: statSync(file.path).size,
        status: grown ? "uploaded" : "unchanged",
      });
    }

    // Session metadata is read, merged, and written back.
    const existing = await this.sessionMeta(input.sessionId);

    const meta: SessionMeta = {
      session: input.sessionId,
      repo: `${input.repo.owner}/${input.repo.repo}`,
      branch: input.branch ?? existing?.branch ?? null,
      pr: existing?.pr ?? null,
      commits: deduplicateStrings([
        ...(existing?.commits ?? []),
        ...(input.commits ?? []).filter(
          (commit) => commitShaSchema.safeParse(commit).success,
        ),
      ]),
      author: input.author ?? existing?.author ?? null,
      ts: new Date().toISOString(),
    };

    const saved = await this.objects.putBuffer(
      metaKey(input.sessionId),
      Buffer.from(JSON.stringify(meta, null, 2), "utf8"),
    );

    if (!saved) {
      throw new Error(
        `Failed to update session metadata for ${input.sessionId} in S3/R2 storage.`,
      );
    }

    return { uploads };
  }

  async associateCommits(input: TraceCommitAssociation): Promise<boolean> {
    const commit = commitShaSchema.parse(input.commit);
    const existing = await this.getJson(commitKey(commit));

    if (existing !== null) return false;
    const { repo, pr } = await input.resolve();

    const entry: ByCommitEntry = byCommitSchema.parse({
      commit,
      sessions: deduplicateStrings(input.sessions),
      repo: `${repo.owner}/${repo.repo}`,
      pr,
      branch: input.branch,
      indexed_by: "hook",
      ts: new Date().toISOString(),
    });

    const saved = await this.objects.putBuffer(
      commitKey(commit),
      Buffer.from(JSON.stringify(entry, null, 2), "utf8"),
    );

    if (!saved) {
      throw new Error(`Failed to write by-commit/${commit}.json.`);
    }

    return true;
  }

  // --- transport -----------------------------------------------------------

  private async getJson(key: string): Promise<JsonValue | null> {
    const tmpPath = path.join(
      tmpdir(),
      `r2-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );

    try {
      if (!(await this.objects.getObject(key, tmpPath))) return null;

      return parseJsonText(readFileSync(tmpPath, "utf8"));
    } catch {
      return null;
    } finally {
      rmSync(tmpPath, { force: true });
    }
  }

  private async putIfGrown(key: string, filePath: string): Promise<boolean> {
    const remoteSize = await this.objects.headObjectSize(key);
    const localSize = statSync(filePath).size;

    if (remoteSize !== null && localSize <= remoteSize) return false;

    if (!(await this.objects.putFile(key, filePath))) {
      throw new Error(`Failed to upload ${key} to S3/R2 storage.`);
    }

    return true;
  }
}

function objectKey(sessionId: string, traceName: string): string {
  return traceName === "main"
    ? `by-session/${sessionId}/trace.jsonl`
    : `by-session/${sessionId}/subagents/${normalizeSubagentFileName(traceName)}`;
}

function metaKey(sessionId: string): string {
  return `by-session/${sessionId}/meta.json`;
}

function commitKey(commit: string): string {
  return `by-commit/${commit}.json`;
}

export function normalizeSubagentFileName(name: string): string {
  const base = path.basename(name);

  return base.endsWith(".jsonl") ? base : `${base}.jsonl`;
}

function deduplicateStrings(items: string[]): string[] {
  return [...new Set(items)];
}
