import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, expect, it } from "vitest";

import { ReviewStore } from "./store.js";

let root: string;

const stores: ReviewStore[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "review-server-id-"));
});

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await rm(root, { recursive: true, force: true });
});

async function open(file = path.join(root, "review-api.db")) {
  const store = await ReviewStore.open(file, {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });

  stores.push(store);

  return store;
}

async function close(store: ReviewStore) {
  stores.splice(stores.indexOf(store), 1);
  await store.close();
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

it("keeps one random id across reopening the store", async () => {
  const first = await open();
  const id = await first.serverId();

  expect(id).toMatch(uuid);
  expect(await first.serverId()).toBe(id);
  await close(first);
  expect(await (await open()).serverId()).toBe(id);
});

it("gives two stores two ids", async () => {
  expect(await (await open(path.join(root, "a.db"))).serverId()).not.toBe(
    await (await open(path.join(root, "b.db"))).serverId(),
  );
});

it("lets the first of two hosts on one store choose the id", async () => {
  const desktop = await open();
  const headless = await open();
  const chosen = await headless.serverId();

  expect(await desktop.serverId()).toBe(chosen);
});

it("gives a store made before the id existed an id", async () => {
  const file = path.join(root, "review-api.db");
  await close(await open(file));
  const db = new DatabaseSync(file);
  db.exec("DROP TABLE server_identity");
  db.close();

  expect(await (await open(file)).serverId()).toMatch(uuid);
});

it("resets the id without changing any review id", async () => {
  const store = await open();

  const { reviewId } = await store.execute({
    operation: {
      type: "create",
      title: "Kept",
      target: {
        kind: "commits",
        repositoryId: "repo",
        base: "base",
        head: "head",
      },
    },
  });

  const before = await store.serverId();
  const after = await store.resetServerId();

  expect(after).toMatch(uuid);
  expect(after).not.toBe(before);
  expect(await store.serverId()).toBe(after);
  expect((await store.list()).map((review) => review.reviewId)).toEqual([
    reviewId,
  ]);
});
