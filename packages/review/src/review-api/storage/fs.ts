import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomicAsync } from "@dev.fast/trace-core";
import { isMissingFileError } from "@review/fs-utils.js";

import {
  type BlobStore,
  type BlobStoreLimits,
  DEFAULT_MAX_OBJECT_BYTES,
  assertBlobSize,
  blobObjectId,
  isBlobObjectId,
} from "./blob-store.js";

/**
 * Content-addressed objects as files under `dir`, named by their id. The
 * server streams them back to the browser itself, so this store has no
 * `signedReadUrl`.
 */
export class FsBlobStore implements BlobStore {
  private readonly maxObjectBytes: number;

  constructor(
    private readonly dir: string,
    limits: BlobStoreLimits = {},
  ) {
    this.maxObjectBytes = limits.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  }

  async put(bytes: Uint8Array): Promise<string> {
    assertBlobSize(bytes, this.maxObjectBytes);
    const id = blobObjectId(bytes);
    const file = this.objectPath(id);

    // An object at its content id already holds these bytes; a shorter one is
    // corruption an atomic rewrite can heal.
    const existing = await stat(file).catch(() => null);

    if (existing?.isFile() && existing.size === bytes.byteLength) return id;

    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFileAtomicAsync(file, bytes, { mode: 0o600 });

    return id;
  }

  async get(id: string): Promise<Uint8Array | null> {
    if (!isBlobObjectId(id)) return null;

    let bytes: Buffer;

    try {
      bytes = await readFile(this.objectPath(id));
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }

    if (blobObjectId(bytes) !== id) {
      throw new Error(`Blob ${id} does not match its content id.`);
    }

    return bytes;
  }

  async has(id: string): Promise<boolean> {
    if (!isBlobObjectId(id)) return false;

    const stats = await stat(this.objectPath(id)).catch(() => null);

    return stats?.isFile() === true;
  }

  private objectPath(id: string): string {
    return path.join(this.dir, id);
  }
}
