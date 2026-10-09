import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type S3Credentials,
  S3ObjectClient,
  S3_DEFAULT_REGION,
} from "@dev.fast/trace-core";

import {
  type BlobStore,
  type BlobStoreLimits,
  DEFAULT_MAX_OBJECT_BYTES,
  assertBlobSize,
  blobObjectId,
  isBlobObjectId,
} from "./blob-store.js";

/**
 * S3-compatible bucket settings (S3, R2, MinIO, or GCS's S3 interop): the
 * endpoint and the bucket's signing credentials, reusing the trace store's
 * AWS-CLI object client rather than a second S3 library.
 */
export interface S3BlobStoreConfig extends BlobStoreLimits {
  endpoint?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** SigV4 signing region. R2 accepts "auto"; AWS S3 needs the bucket's. */
  region?: string;
  /** Key prefix the objects live under; default "blobs/". */
  prefix?: string;
  /** Test double: keys become files under this directory instead of a bucket. */
  mockDir?: string;
}

/**
 * Content-addressed objects in a bucket, `<prefix><id>` per object. Remote
 * mode's browser reads go through `signedReadUrl`; the other methods stream
 * through the shared object client.
 */
export class S3BlobStore implements BlobStore {
  private readonly client: S3ObjectClient;
  private readonly prefix: string;
  private readonly maxObjectBytes: number;

  constructor(config: S3BlobStoreConfig, env: NodeJS.ProcessEnv = process.env) {
    const {
      prefix = "blobs/",
      mockDir,
      maxObjectBytes,
      endpoint,
      bucket,
      accessKeyId,
      secretAccessKey,
      region,
    } = config;

    this.prefix = prefix.endsWith("/") || prefix === "" ? prefix : `${prefix}/`;
    this.maxObjectBytes = maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;

    const credentials: S3Credentials | null = mockDir
      ? null
      : endpoint && bucket && accessKeyId && secretAccessKey
        ? {
            endpoint,
            bucket,
            accessKeyId,
            secretAccessKey,
            region: region ?? S3_DEFAULT_REGION,
          }
        : null;

    if (!mockDir && !credentials) {
      throw new Error(
        "S3 blob storage needs endpoint, bucket, accessKeyId, and secretAccessKey.",
      );
    }

    this.client = new S3ObjectClient(credentials, mockDir ?? null, env);
  }

  async put(bytes: Uint8Array): Promise<string> {
    assertBlobSize(bytes, this.maxObjectBytes);
    const id = blobObjectId(bytes);
    const key = this.objectKey(id);

    // An object already stored at its content id holds these bytes; a size
    // mismatch means an interrupted earlier upload, so write again.
    if ((await this.client.headObjectSize(key)) === bytes.byteLength) {
      return id;
    }

    if (!(await this.client.putBuffer(key, bytes))) {
      throw new Error(`Failed to write blob ${id} to S3/R2 storage.`);
    }

    return id;
  }

  async get(id: string): Promise<Uint8Array | null> {
    if (!isBlobObjectId(id)) return null;

    const tempPath = path.join(
      tmpdir(),
      `blob-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`,
    );

    try {
      if (!(await this.client.getObject(this.objectKey(id), tempPath))) {
        return null;
      }

      const bytes = await readFile(tempPath);

      if (blobObjectId(bytes) !== id) {
        throw new Error(`Blob ${id} does not match its content id.`);
      }

      return bytes;
    } finally {
      await rm(tempPath, { force: true });
    }
  }

  async has(id: string): Promise<boolean> {
    if (!isBlobObjectId(id)) return false;

    return (await this.client.headObjectSize(this.objectKey(id))) !== null;
  }

  async signedReadUrl(id: string): Promise<string> {
    if (!isBlobObjectId(id)) throw new Error(`"${id}" is not a blob id.`);

    return this.client.presignGetUrl(this.objectKey(id));
  }

  private objectKey(id: string): string {
    return `${this.prefix}${id}`;
  }
}
