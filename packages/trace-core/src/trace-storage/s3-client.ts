import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  jsonArray,
  jsonNumber,
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/json";

import { errorMessage } from "../error-message";
import type { S3Credentials } from "./s3-config";
import type { TraceStorageReadiness } from "./types";

const execFileAsync = promisify(execFile);

/**
 * One S3-compatible bucket's object operations through the AWS CLI — the only
 * S3 transport in this codebase, shared by the trace store and the review blob
 * store so both sign requests the same way.
 *
 * A null `config` is the test double: keys are files under `mockRoot`, and a
 * null `mockRoot` stores nothing anywhere.
 */
export class S3ObjectClient {
  constructor(
    private readonly config: S3Credentials | null,
    private readonly mockRoot: string | null,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  /** A non-mutating reachability check of the configured bucket. */
  async readiness(): Promise<TraceStorageReadiness> {
    if (!this.config) return { ready: true };

    try {
      await this.run(["s3api", "head-bucket", "--bucket", this.config.bucket], {
        timeout: 15_000,
      });

      return { ready: true };
    } catch (error) {
      return { ready: false, reason: errorMessage(error) };
    }
  }

  /** The object's byte size, or null when absent or unreadable. */
  async headObjectSize(key: string): Promise<number | null> {
    if (!this.config) {
      if (!this.mockRoot) return null;

      try {
        const stats = statSync(path.join(this.mockRoot, key));

        return stats.isFile() ? stats.size : null;
      } catch {
        return null;
      }
    }

    try {
      const proc = await this.run(
        ["s3api", "head-object", "--bucket", this.config.bucket, "--key", key],
        { timeout: 10_000 },
      );

      return (
        jsonNumber(jsonObject(parseJsonText(proc.stdout))?.ContentLength) ??
        null
      );
    } catch {
      return null;
    }
  }

  /** Downloads `key` to `destPath`; false when absent or the transfer failed. */
  async getObject(key: string, destPath: string): Promise<boolean> {
    mkdirSync(path.dirname(destPath), { recursive: true });

    if (!this.config) {
      if (!this.mockRoot) return false;

      try {
        writeFileSync(destPath, readFileSync(path.join(this.mockRoot, key)));

        return true;
      } catch {
        return false;
      }
    }

    try {
      await this.run(
        [
          "s3api",
          "get-object",
          "--bucket",
          this.config.bucket,
          "--key",
          key,
          destPath,
        ],
        { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      );

      return existsSync(destPath);
    } catch {
      return false;
    }
  }

  /** Keys directly under `prefix`; a failed or absent listing reads empty. */
  async listKeys(prefix: string): Promise<string[]> {
    if (!this.config) {
      if (!this.mockRoot) return [];

      try {
        return readdirSync(path.join(this.mockRoot, prefix)).map(
          (entry) => `${prefix}${entry}`,
        );
      } catch {
        return [];
      }
    }

    try {
      const proc = await this.run(
        [
          "s3api",
          "list-objects-v2",
          "--bucket",
          this.config.bucket,
          "--prefix",
          prefix,
        ],
        { timeout: 10_000 },
      );

      const listing = jsonObject(parseJsonText(proc.stdout));
      const keys: string[] = [];

      for (const item of jsonArray(listing?.Contents) ?? []) {
        const key = jsonString(jsonObject(item)?.Key);

        if (key && key.startsWith(prefix)) keys.push(key);
      }

      return keys;
    } catch {
      return [];
    }
  }

  /** Uploads a local file to `key`; false when the store cannot take it. */
  async putFile(key: string, filePath: string): Promise<boolean> {
    if (!this.config) {
      if (!this.mockRoot) return false;

      try {
        const target = path.join(this.mockRoot, key);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(filePath));

        return true;
      } catch {
        return false;
      }
    }

    try {
      await this.run(
        [
          "s3",
          "cp",
          "--only-show-errors",
          filePath,
          `s3://${this.config.bucket}/${key}`,
        ],
        { timeout: 60_000 },
      );

      return true;
    } catch {
      return false;
    }
  }

  /** Uploads `content` to `key`; false when the store cannot take it. */
  async putBuffer(key: string, content: Uint8Array): Promise<boolean> {
    if (!this.config) {
      if (!this.mockRoot) return false;

      try {
        const target = path.join(this.mockRoot, key);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);

        return true;
      } catch {
        return false;
      }
    }

    const tempFile = path.join(
      tmpdir(),
      `put-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`,
    );

    writeFileSync(tempFile, content);

    try {
      return await this.putFile(key, tempFile);
    } finally {
      rmSync(tempFile, { force: true });
    }
  }

  /**
   * A presigned GET URL for `key` expiring in `expiresInSeconds`. The test
   * double answers a file URL into `mockRoot`; no configuration throws.
   */
  async presignGetUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    if (!this.config) {
      if (!this.mockRoot)
        throw new Error("S3 object storage is not configured.");

      return pathToFileURL(path.join(this.mockRoot, key)).href;
    }

    const proc = await this.run(
      [
        "s3",
        "presign",
        `s3://${this.config.bucket}/${key}`,
        "--expires-in",
        String(Math.max(1, Math.floor(expiresInSeconds))),
      ],
      { timeout: 10_000 },
    );

    return proc.stdout.trim();
  }

  /** The AWS CLI call every object operation composes. */
  private run(
    args: string[],
    options: { timeout: number; maxBuffer?: number },
  ): Promise<{ stdout: string; stderr: string }> {
    const config = this.config;

    if (!config) throw new Error("S3 object storage is not configured.");

    return execFileAsync(
      "aws",
      ["--region", config.region, "--endpoint-url", config.endpoint, ...args],
      {
        ...options,
        env: {
          ...this.env,
          AWS_ACCESS_KEY_ID: config.accessKeyId,
          AWS_SECRET_ACCESS_KEY: config.secretAccessKey,
        },
      },
    );
  }
}
