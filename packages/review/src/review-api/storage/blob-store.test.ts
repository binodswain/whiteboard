import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { MAX_SHARE_OBJECT_BYTES } from "@dev.fast/review-share-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type BlobStore,
  BlobTooLargeError,
  createBlobStore,
} from "./blob-store.js";

const execFileAsync = promisify(execFile);

// The s3 backend also runs against a real bucket when the environment names
// one — MinIO via `docker run -p 9000:9000 minio/minio server /data` works:
//
//   TEST_S3_ENDPOINT=http://127.0.0.1:9000 \
//   TEST_S3_BUCKET=blob-store-test \
//   TEST_S3_ACCESS_KEY_ID=minioadmin \
//   TEST_S3_SECRET_ACCESS_KEY=minioadmin \
//   pnpm test -- src/review-api/storage/blob-store.test.ts

const s3Test = process.env.TEST_S3_ENDPOINT
  ? {
      endpoint: process.env.TEST_S3_ENDPOINT,
      bucket: process.env.TEST_S3_BUCKET ?? "blob-store-test",
      accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? "minioadmin",
      secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? "minioadmin",
      region: process.env.TEST_S3_REGION ?? "us-east-1",
    }
  : {
      endpoint: "",
      bucket: "",
      accessKeyId: "",
      secretAccessKey: "",
      region: "us-east-1",
    };

/** Byte equality across Buffer and Uint8Array views. */
function expectBytes(actual: Uint8Array, expected: Uint8Array) {
  expect(Buffer.compare(Buffer.from(actual), Buffer.from(expected))).toBe(0);
}

/** GET a URL's bytes, failing on a non-2xx response. */
async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);

  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);

  return new Uint8Array(await response.arrayBuffer());
}

interface ContractRun {
  store: BlobStore;
  /** How many objects the backend holds for this run's namespace. */
  storedObjects(): Promise<number>;
  /** The limit this run's store enforces. */
  maxObjectBytes: number;
  /** Whether the backend offers signedReadUrl. */
  signedReadUrl: boolean;
  cleanup?(): void;
}

/** The behavior every BlobStore backend must satisfy. */
function blobStoreContract(name: string, open: () => Promise<ContractRun>) {
  describe(`blob store contract: ${name}`, () => {
    let run: ContractRun;

    beforeEach(async () => {
      run = await open();
    });

    afterEach(() => run.cleanup?.());

    it("round-trips bytes by their sha256 id", async () => {
      const bytes = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31) % 251);

      const id = await run.store.put(bytes);

      expect(id).toMatch(/^[a-f0-9]{64}$/);
      expect(id).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(await run.store.has(id)).toBe(true);
      expectBytes((await run.store.get(id))!, bytes);
    });

    it("round-trips an empty object", async () => {
      const id = await run.store.put(new Uint8Array(0));

      expect(await run.store.has(id)).toBe(true);
      expectBytes((await run.store.get(id))!, new Uint8Array(0));
    });

    it("answers null and false for missing and malformed ids", async () => {
      const missing = "0".repeat(64);

      expect(await run.store.get(missing)).toBeNull();
      expect(await run.store.has(missing)).toBe(false);
      expect(await run.store.get("../../etc/passwd")).toBeNull();
      expect(await run.store.has("not-a-digest")).toBe(false);
      expect(await run.store.get("0".repeat(63))).toBeNull();
    });

    it("stores one object when the same content is written twice", async () => {
      const bytes = Buffer.from("the same bytes", "utf8");
      const other = Buffer.from("different bytes", "utf8");

      const first = await run.store.put(bytes);
      const second = await run.store.put(bytes);

      expect(second).toBe(first);
      expect(await run.storedObjects()).toBe(1);

      await run.store.put(other);
      expect(await run.storedObjects()).toBe(2);
    });

    it("rejects an object over the size limit before storing it", async () => {
      const oversized = new Uint8Array(run.maxObjectBytes + 1);

      await expect(run.store.put(oversized)).rejects.toBeInstanceOf(
        BlobTooLargeError,
      );
      await expect(run.store.put(oversized)).rejects.toMatchObject({
        size: run.maxObjectBytes + 1,
        limit: run.maxObjectBytes,
      });
      expect(await run.storedObjects()).toBe(0);
    });

    it("serves a readable URL when the backend offers signedReadUrl", async () => {
      const bytes = Buffer.from("bytes behind a signed url", "utf8");
      const id = await run.store.put(bytes);

      expect(run.store.signedReadUrl !== undefined).toBe(run.signedReadUrl);

      if (!run.store.signedReadUrl) return;

      const url = await run.store.signedReadUrl(id);

      const served = url.startsWith("file:")
        ? new Uint8Array(await readFile(fileURLToPath(url)))
        : await fetchBytes(url);

      expectBytes(served, bytes);
    });
  });
}

/** Regular files under `root` — what a directory-backed store actually wrote. */
async function countFiles(root: string): Promise<number> {
  try {
    const entries = await readdir(root, {
      recursive: true,
      withFileTypes: true,
    });

    return entries.filter(
      (entry) => entry.isFile() && !entry.name.endsWith(".tmp"),
    ).length;
  } catch {
    return 0;
  }
}

blobStoreContract("fs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blob-store-fs-"));

  return {
    store: createBlobStore({ driver: "fs", dir }),
    storedObjects: () => countFiles(dir),
    maxObjectBytes: MAX_SHARE_OBJECT_BYTES,
    signedReadUrl: false,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
});

blobStoreContract("s3 with a mock directory", async () => {
  const mockDir = mkdtempSync(path.join(tmpdir(), "blob-store-s3-mock-"));

  return {
    store: createBlobStore({ driver: "s3", mockDir }),
    storedObjects: () => countFiles(mockDir),
    maxObjectBytes: MAX_SHARE_OBJECT_BYTES,
    signedReadUrl: true,
    cleanup: () => rmSync(mockDir, { recursive: true, force: true }),
  };
});

describe.skipIf(!process.env.TEST_S3_ENDPOINT)(
  "blob store contract: s3 at TEST_S3_ENDPOINT",
  () => {
    const awsEnv = {
      ...process.env,
      AWS_ACCESS_KEY_ID: s3Test.accessKeyId,
      AWS_SECRET_ACCESS_KEY: s3Test.secretAccessKey,
    };

    function aws(args: string[]) {
      return execFileAsync(
        "aws",
        ["--region", s3Test.region, "--endpoint-url", s3Test.endpoint, ...args],
        { env: awsEnv, timeout: 15_000 },
      );
    }

    // The aws CLI pays process startup and 404 retries per call, so real
    // bucket operations need more room than the unit-test default.
    beforeEach(async () => {
      // Create the bucket; "already owned" is the common second run.
      await aws(["s3", "mb", `s3://${s3Test.bucket}`]).catch(() => undefined);
      await aws(["s3api", "head-bucket", "--bucket", s3Test.bucket]);
    }, 30_000);

    it("round-trips through the real bucket", async () => {
      // A unique prefix per run keeps assertions isolated on a shared bucket.
      const prefix = `test/${randomBytes(8).toString("hex")}/`;
      const store = createBlobStore({ driver: "s3", ...s3Test, prefix });

      const storedObjects = async () => {
        const proc = await aws([
          "s3api",
          "list-objects-v2",
          "--bucket",
          s3Test.bucket,
          "--prefix",
          prefix,
        ]);

        return (JSON.parse(proc.stdout).Contents ?? []).length;
      };

      const bytes = Uint8Array.from({ length: 8192 }, (_, i) => i % 256);
      const id = await store.put(bytes);

      expect(id).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(await store.has(id)).toBe(true);
      expectBytes((await store.get(id))!, bytes);
      expect(await store.get("0".repeat(64))).toBeNull();

      // A repeat write is content-addressed: one object.
      await store.put(bytes);
      expect(await storedObjects()).toBe(1);

      // The signed URL serves the same bytes.
      const url = await store.signedReadUrl!(id);
      const response = await fetch(url);
      expect(response.ok).toBe(true);
      expectBytes(new Uint8Array(await response.arrayBuffer()), bytes);

      // The limit rejects before any object lands.
      await expect(
        store.put(new Uint8Array(MAX_SHARE_OBJECT_BYTES + 1)),
      ).rejects.toBeInstanceOf(BlobTooLargeError);
      expect(await storedObjects()).toBe(1);
    }, 90_000);
  },
);

describe("createBlobStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "blob-store-config-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("defaults to the filesystem under DEV_REVIEW_SERVER_DIR", async () => {
    const store = createBlobStore({}, { DEV_REVIEW_SERVER_DIR: dir });
    const bytes = Buffer.from("default placement", "utf8");
    const id = await store.put(bytes);

    const file = await stat(path.join(dir, "blobs", id));
    expect(file.isFile()).toBe(true);
    expectBytes((await store.get(id))!, bytes);
  });

  it("honors a custom per-object limit", async () => {
    const store = createBlobStore({ driver: "fs", dir, maxObjectBytes: 8 });

    await expect(
      store.put(Buffer.from("nine bytes", "utf8")),
    ).rejects.toBeInstanceOf(BlobTooLargeError);
    expect(await store.put(Buffer.from("fits", "utf8"))).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("fails s3 configuration without credentials or a mock directory", () => {
    expect(() => createBlobStore({ driver: "s3" })).toThrow(
      /endpoint, bucket, accessKeyId, and secretAccessKey/,
    );
  });
});

describe("fs blob store", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "blob-store-fs-extra-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses bytes whose content no longer matches their id", async () => {
    const store = createBlobStore({ driver: "fs", dir });
    const id = await store.put(Buffer.from("original", "utf8"));

    writeFileSync(path.join(dir, id), "tampered");

    await expect(store.get(id)).rejects.toThrow(/does not match/);
  });
});
