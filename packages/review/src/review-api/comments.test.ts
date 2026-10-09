import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReviewComments, relocateLines } from "./comments.js";
import {
  type MetadataStore,
  createMetadataStore,
} from "./storage/metadata-store.js";

describe("relocateLines", () => {
  const before = ["a", "b", "c", "d"];

  it("keeps a range whose lines are unchanged in place", () => {
    expect(relocateLines(before, ["a", "b", "c", "d"], 2, 3)).toEqual({
      start: 2,
      end: 3,
    });
  });

  it("follows a range that moved to a single new position", () => {
    expect(relocateLines(before, ["z", "z", "b", "c", "d"], 2, 3)).toEqual({
      start: 3,
      end: 4,
    });
  });

  it("reports a range whose lines were changed", () => {
    expect(relocateLines(before, ["a", "B", "c", "d"], 2, 3)).toBeUndefined();
  });

  it("reports a range that now appears more than once", () => {
    expect(
      relocateLines(["x", "y"], ["q", "x", "y", "x", "y"], 1, 2),
    ).toBeUndefined();
  });
});

describe("ReviewComments", () => {
  let meta: MetadataStore;
  let comments: ReviewComments;

  beforeEach(async () => {
    meta = await createMetadataStore({ kind: "sqlite", dir: ":memory:" });
    comments = new ReviewComments(meta);
  });

  afterEach(async () => {
    await meta.close();
  });

  it("lists threads with replies joined to the root", async () => {
    const root = await comments.add("r1", 0, {
      body: "Why not a map?",
      author: "ana",
      anchor: "head/src/a.ts#L2",
    });

    await comments.add("r1", 0, {
      body: "It is a list.",
      author: "bo",
      parentId: root.id,
    });

    const listed = await comments.list("r1");

    expect(listed.find((item) => item.parentId)).toMatchObject({
      author: "bo",
      parentId: root.id,
    });
    expect(listed.find((item) => item.id === root.id)).toMatchObject({
      anchor: "head/src/a.ts#L2",
      resolved: false,
      outdated: false,
    });
  });

  it("resolves the whole thread from any of its comments", async () => {
    const root = await comments.add("r1", 0, { body: "Nit" });

    const reply = await comments.add("r1", 0, {
      body: "Fixed",
      parentId: root.id,
    });

    await comments.setResolved("r1", reply.id, true);

    expect((await comments.list("r1")).map((item) => item.resolved)).toEqual([
      true,
      true,
    ]);
  });

  it("keeps a comment attached when its lines survive a new version", async () => {
    const root = await comments.add("r1", 0, {
      body: "Keep",
      anchor: "head/src/a.ts#L2-L3",
    });

    await comments.carryForward(
      "r1",
      1,
      {
        previous: async () => "a\nb\nc\nd",
        next: async () => "inserted\na\nb\nc\nd",
      },
      new Set(),
    );

    expect((await comments.list("r1"))[0]).toMatchObject({
      id: root.id,
      anchor: "head/src/a.ts#L3-L4",
      version: 1,
      outdated: false,
    });
  });

  it("marks a comment outdated when its lines changed", async () => {
    await comments.add("r1", 0, {
      body: "Stale",
      anchor: "head/src/a.ts#L2",
    });

    await comments.carryForward(
      "r1",
      1,
      {
        previous: async () => "a\nb\nc",
        next: async () => "a\nB\nc",
      },
      new Set(),
    );

    expect((await comments.list("r1"))[0]).toMatchObject({
      anchor: "head/src/a.ts#L2",
      outdated: true,
    });
  });

  it("marks an element anchor outdated once its element is gone", async () => {
    await comments.add("r1", 0, { body: "Node", anchor: "element:n1" });

    const none = { previous: async () => "", next: async () => "" };

    await comments.carryForward("r1", 1, none, new Set(["n2"]));

    expect((await comments.list("r1"))[0]).toMatchObject({ outdated: true });
  });
});
