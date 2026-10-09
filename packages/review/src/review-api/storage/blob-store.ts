import { createHash } from "node:crypto";
import path from "node:path";

import {
  MAX_SHARE_OBJECT_BYTES,
  objectIdSchema,
} from "@dev.fast/review-share-protocol";
import { reviewServerStateDir } from "@review/server-discovery.js";

import { FsBlobStore } from "./fs.js";
import { S3BlobStore, type S3BlobStoreConfig } from "./s3.js";

/**
 * Content-addressed object storage for review payloads — bundles, diagrams,
 * and uploaded assets. The object id is the sha256 of its bytes, so writing
 * the same content twice stores one object, and a reader can verify that what
 * it receives is what the id names.
 *
 * Local mode uses `fs` under the server state directory and streams objects
 * back through the server. Remote mode uses an S3-compatible bucket and can
 * hand the browser a signed read URL instead.
 */
export interface BlobStore {
  /**
   * Stores `bytes` and resolves the content id. A second `put` of the same
   * bytes is a no-op; a `put` larger than the store's object limit rejects
   * with a `BlobTooLargeError`.
   */
  put(bytes: Uint8Array): Promise<string>;
  /**
   * The stored bytes, or null when no object has `id`. Resolves null (never a
   * read) for an id that is not a sha256 hex digest; throws when the stored
   * bytes do not match the id.
   */
  get(id: string): Promise<Uint8Array | null>;
  /** Whether an object with `id` is stored; false for a malformed id. */
  has(id: string): Promise<boolean>;
  /**
   * A URL a browser can read the object from directly — a presigned URL in
   * remote mode. Absent where the server always serves the bytes itself.
   */
  signedReadUrl?(id: string): Promise<string>;
}

/** The share-format object limit is the default cap on every store. */
export const DEFAULT_MAX_OBJECT_BYTES = MAX_SHARE_OBJECT_BYTES;

/** A write exceeded the store's per-object limit. */
export class BlobTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(
      `The object is ${size} bytes; the per-object limit is ${limit} bytes.`,
    );
    this.name = "BlobTooLargeError";
  }
}

export interface BlobStoreLimits {
  /** Per-object cap in bytes; defaults to MAX_SHARE_OBJECT_BYTES. */
  maxObjectBytes?: number;
}

export type BlobStoreConfig =
  | ({
      /** Objects are files under a directory — the default driver. */
      driver?: "fs";
      /** Object root; defaults to `blobs` under the server state directory. */
      dir?: string;
    } & BlobStoreLimits)
  | ({ driver: "s3" } & S3BlobStoreConfig & BlobStoreLimits);

/**
 * The store for a server's resolved configuration. With no config — the local
 * default — objects are files under `DEV_REVIEW_SERVER_DIR` (or the Review
 * home when it is unset).
 */
export function createBlobStore(
  config: BlobStoreConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): BlobStore {
  if (config.driver === "s3") return new S3BlobStore(config, env);

  return new FsBlobStore(
    config.dir ?? path.join(reviewServerStateDir(env), "blobs"),
    config,
  );
}

/** The content id of `bytes`: its sha256 as lowercase hex. */
export function blobObjectId(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isBlobObjectId(id: string): boolean {
  return objectIdSchema.safeParse(id).success;
}

export function assertBlobSize(bytes: Uint8Array, limit: number): void {
  if (bytes.byteLength > limit)
    throw new BlobTooLargeError(bytes.byteLength, limit);
}
