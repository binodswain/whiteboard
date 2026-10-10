import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type MetadataStore,
  createMetadataStore,
} from "@review/review-api/storage/metadata-store.js";
import { afterAll, describe, expect, it } from "vitest";

import { AskQueue } from "./queue.js";

const stores: MetadataStore[] = [];

const dirs: string[] = [];

async function queue() {
  const dir = mkdtempSync(path.join(tmpdir(), "ask-queue-"));
  dirs.push(dir);

  const store = await createMetadataStore({
    kind: "sqlite",
    dir: path.join(dir, "asks.db"),
  });

  stores.push(store);

  return new AskQueue(store);
}

afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()));

  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("AskQueue", () => {
  it("allows only one runner to claim an ask", async () => {
    const asks = await queue();

    const askId = await asks.create({
      reviewId: "review",
      prompt: "draw login",
      createdBy: "board",
    });

    const claims = await Promise.all([
      asks.claim(askId, "runner-a"),
      asks.claim(askId, "runner-b"),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await asks.get(askId)).toMatchObject({
      status: "running",
      attempts: 1,
    });
  });

  it("returns expired work to pending and fails it after the attempt limit", async () => {
    const asks = await queue();

    const askId = await asks.create({
      reviewId: "review",
      prompt: "draw login",
      createdBy: "board",
      maxAttempts: 2,
    });

    await asks.claim(askId, "runner-a", { now: 1000, leaseMs: 10 });
    await asks.reapExpired(1011);
    expect(await asks.get(askId)).toMatchObject({
      status: "pending",
      attempts: 1,
    });

    await asks.claim(askId, "runner-b", { now: 1012, leaseMs: 10 });
    await asks.reapExpired(1023);
    expect(await asks.get(askId)).toMatchObject({
      status: "failed",
      attempts: 2,
    });
  });

  it("stores result references when a runner completes an ask", async () => {
    const asks = await queue();

    const askId = await asks.create({
      reviewId: "review",
      prompt: "draw login",
      createdBy: "board",
    });

    await asks.claim(askId, "runner-a");

    expect(await asks.complete(askId, "runner-a", ["block-1"])).toBe(true);
    expect(await asks.get(askId)).toMatchObject({
      status: "done",
      resultRefs: ["block-1"],
    });
  });

  it("renews a lease past its original expiry", async () => {
    const asks = await queue();

    const askId = await asks.create({
      reviewId: "review",
      prompt: "draw login",
      createdBy: "board",
    });

    await asks.claim(askId, "runner-a", { now: 1000, leaseMs: 10 });
    expect(
      await asks.heartbeat(askId, "runner-a", { now: 1009, leaseMs: 10 }),
    ).toBe(true);

    await asks.reapExpired(1011);
    expect(await asks.get(askId)).toMatchObject({
      status: "running",
      claimedBy: "runner-a",
      leaseUntil: 1019,
    });
  });

  it("rejects an old runner after its ask is reaped", async () => {
    const asks = await queue();

    const askId = await asks.create({
      reviewId: "review",
      prompt: "draw login",
      createdBy: "board",
    });

    await asks.claim(askId, "runner-a", { now: 1000, leaseMs: 10 });
    await asks.reapExpired(1011);

    expect(await asks.heartbeat(askId, "runner-a", { now: 1012 })).toBe(false);
    expect(await asks.complete(askId, "runner-a", [])).toBe(false);
  });
});
