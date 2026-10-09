import { mkdtempSync, rmSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createReviewApi } from "./http.js";
import { type ReviewProviders, ReviewStore } from "./store.js";

const pins = { repositoryId: "repo", base: "base-commit", head: "head-commit" };

let directory: string;

let store: ReviewStore;

let texts: Record<string, Record<string, string>>;

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "review-comments-http-"));
  vi.stubEnv("DEV_REVIEW_HOME", directory);
  texts = {};

  const providers: ReviewProviders = {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
    fileText: async (at, side, file) => texts[at.head]?.[file],
  };

  store = await ReviewStore.open(path.join(directory, "reviews.db"), providers);
});

afterEach(async () => {
  await store.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

const app = () => createReviewApi(store);

const createReview = async () => {
  const { reviewId } = await store.execute({
    operation: {
      type: "create",
      title: "Comments",
      target: { kind: "commits", ...pins },
    },
  });

  return reviewId;
};

const get = (route: string) => app().request(route);

interface CommentRequest {
  body: string;
  author?: string;
  anchor?: string;
  parentId?: string;
}

interface ResolveRequest {
  commentId: string;
  resolved?: boolean;
}

const post = (route: string, body: CommentRequest | ResolveRequest) =>
  app().request(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const json = async <T>(response: Response) => (await response.json()) as T;

interface CommentJson {
  id: string;
  body: string;
  author: string;
  anchor?: string;
  parentId?: string;
  version: number;
  resolved: boolean;
  outdated: boolean;
}

const listed = async (reviewId: string) =>
  (await json<{ comments: CommentJson[] }>(await get(`/${reviewId}/comments`)))
    .comments;

it("lists no comments on a new review", async () => {
  const reviewId = await createReview();

  const response = await get(`/${reviewId}/comments`);

  expect(response.status).toBe(200);
  expect(await json(response)).toEqual({ comments: [] });
});

it("adds a comment on a line range, authored by the local user when none is given", async () => {
  const reviewId = await createReview();

  const response = await post(`/${reviewId}/comments`, {
    body: "Why two lines?",
    anchor: "head/src/a.ts#L2-L3",
  });

  expect(response.status).toBe(201);
  expect(await json(response)).toMatchObject({
    body: "Why two lines?",
    anchor: "head/src/a.ts#L2-L3",
    author: os.userInfo().username,
    resolved: false,
    outdated: false,
  });
  expect(await listed(reviewId)).toHaveLength(1);
});

it("keeps an author the client names", async () => {
  const reviewId = await createReview();

  const response = await post(`/${reviewId}/comments`, {
    body: "Looks right",
    author: "ana",
  });

  expect(await json(response)).toMatchObject({ author: "ana" });
});

it("rejects a comment with an empty body", async () => {
  const reviewId = await createReview();

  const response = await post(`/${reviewId}/comments`, { body: "   " });

  expect(response.status).toBe(400);
  expect(await listed(reviewId)).toEqual([]);
});

it("joins a reply to the root of its thread", async () => {
  const reviewId = await createReview();

  const root = await json<CommentJson>(
    await post(`/${reviewId}/comments`, { body: "Nit", author: "ana" }),
  );

  const reply = await json<CommentJson>(
    await post(`/${reviewId}/comments`, {
      body: "Agreed",
      author: "bo",
      parentId: root.id,
    }),
  );

  const nested = await post(`/${reviewId}/comments`, {
    body: "Fixed",
    author: "ana",
    parentId: reply.id,
  });

  expect(await json(nested)).toMatchObject({ parentId: root.id });
});

it("resolves a whole thread from any of its comments and reopens it", async () => {
  const reviewId = await createReview();

  const root = await json<CommentJson>(
    await post(`/${reviewId}/comments`, { body: "Nit" }),
  );

  const reply = await json<CommentJson>(
    await post(`/${reviewId}/comments`, { body: "Done", parentId: root.id }),
  );

  const resolved = await post(`/${reviewId}/comments/resolve`, {
    commentId: reply.id,
  });

  expect(resolved.status).toBe(200);
  expect(
    (await json<{ comments: CommentJson[] }>(resolved)).comments.map(
      (item) => item.resolved,
    ),
  ).toEqual([true, true]);

  const reopened = await post(`/${reviewId}/comments/resolve`, {
    commentId: root.id,
    resolved: false,
  });

  expect(
    (await json<{ comments: CommentJson[] }>(reopened)).comments.map(
      (item) => item.resolved,
    ),
  ).toEqual([false, false]);
});

it("reports an unknown comment as not found when resolving it", async () => {
  const reviewId = await createReview();

  const response = await post(`/${reviewId}/comments/resolve`, {
    commentId: "missing",
  });

  expect(response.status).toBe(404);
});

const moveTarget = (reviewId: string, head: string) =>
  store.execute({
    operation: {
      type: "set_target",
      reviewId,
      target: { kind: "commits", ...pins, head },
    },
  });

it("keeps a comment on unchanged lines attached to its new position in a new version", async () => {
  texts["head-commit"] = { "src/a.ts": "one\ntwo\nthree\nfour" };
  texts["head-2"] = { "src/a.ts": "zero\none\ntwo\nthree\nfour" };
  const reviewId = await createReview();
  await post(`/${reviewId}/comments`, {
    body: "Keep",
    anchor: "head/src/a.ts#L2-L3",
    author: "ana",
  });

  await moveTarget(reviewId, "head-2");

  const { version } = await store.read(reviewId);
  expect(await listed(reviewId)).toEqual([
    expect.objectContaining({
      anchor: "head/src/a.ts#L3-L4",
      version,
      outdated: false,
    }),
  ]);
});

it("marks a comment outdated when its lines changed in a new version", async () => {
  texts["head-commit"] = { "src/a.ts": "one\ntwo\nthree\nfour" };
  texts["head-2"] = { "src/a.ts": "zero\none\nTWO\nthree\nfour" };
  const reviewId = await createReview();
  await post(`/${reviewId}/comments`, {
    body: "Stale",
    anchor: "head/src/a.ts#L2-L3",
    author: "ana",
  });

  await moveTarget(reviewId, "head-2");

  expect(await listed(reviewId)).toEqual([
    expect.objectContaining({
      anchor: "head/src/a.ts#L2-L3",
      outdated: true,
    }),
  ]);
});
