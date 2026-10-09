import { afterEach, expect, it, vi } from "vitest";

import { ACTIVITY_TTL_MS, ReviewActivity } from "./activity.js";
import { ReviewApiClient } from "./client.js";
import { createReviewApi } from "./http.js";
import {
  type MetadataStore,
  createMetadataStore,
} from "./storage/metadata-store.js";
import { ReviewStore } from "./store.js";

const databases: MetadataStore[] = [];

const newActivity = async () => {
  const meta = await createMetadataStore({ kind: "sqlite", dir: ":memory:" });
  databases.push(meta);

  const activity = new ReviewActivity(meta);
  await activity.init();

  return activity;
};

afterEach(async () => {
  vi.useRealTimers();

  for (const meta of databases.splice(0)) await meta.close();
});

it("keeps one presence per agent, ends only the one named, and expires abandoned ones", async () => {
  vi.useFakeTimers();
  const activity = await newActivity();
  const notify = vi.fn<Parameters<ReviewActivity["subscribe"]>[0]>();
  activity.subscribe(notify);

  const begin = async (reviewId = "review") =>
    (await activity.update(reviewId, { action: "begin" })).activityId!;

  const a = await begin(),
    b = await begin();

  expect((await activity.read("review")).activities).toEqual([
    { activityId: a, slot: 0 },
    { activityId: b, slot: 1 },
  ]);
  await vi.advanceTimersByTimeAsync(ACTIVITY_TTL_MS / 2);
  await activity.update("review", { action: "update", activityId: a });
  expect(
    (await activity.update("review", { action: "end", activityId: b }))
      .workingCount,
  ).toBe(1);
  expect(
    (await activity.update("review", { action: "end", activityId: b }))
      .workingCount,
  ).toBe(1);
  // A freed color goes to the next agent.
  expect((await activity.read("review")).activities?.[0]?.slot).toBe(0);
  expect(await begin()).not.toBe(a);
  expect(
    (await activity.read("review")).activities?.map(({ slot }) => slot),
  ).toEqual([0, 1]);
  await vi.advanceTimersByTimeAsync(ACTIVITY_TTL_MS);
  expect(await activity.read("review")).toEqual({
    workingCount: 0,
    expiresAt: null,
  });
  expect(notify).toHaveBeenLastCalledWith("review");
  await expect(
    activity.update("review", { action: "update", activityId: a }),
  ).rejects.toThrow(/expired/);
  await begin("another");
  expect((await activity.read("review")).workingCount).toBe(0);
  activity.close();
  expect(vi.getTimerCount()).toBe(0);
});

it("reports working transitions without heartbeats or focus changes", async () => {
  vi.useFakeTimers();
  const activity = await newActivity();
  const transitions = vi.fn<() => void>();
  activity.subscribeWorking(transitions);

  const first = (await activity.update("review", { action: "begin" }))
    .activityId!;

  expect(activity.isWorking("review")).toBe(true);
  await activity.update("review", { action: "update", activityId: first });
  await activity.update("review", {
    action: "update",
    activityId: first,
    focus: { description: "Reading the diff" },
  });

  const second = (await activity.update("review", { action: "begin" }))
    .activityId!;

  expect(transitions).toHaveBeenCalledTimes(1);
  await activity.update("review", { action: "end", activityId: first });
  expect(transitions).toHaveBeenCalledTimes(1);
  await activity.update("review", { action: "end", activityId: second });
  expect(activity.isWorking("review")).toBe(false);
  expect(transitions).toHaveBeenCalledTimes(2);
  await activity.update("review", { action: "begin" });
  await vi.advanceTimersByTimeAsync(ACTIVITY_TTL_MS);
  expect(activity.isWorking("review")).toBe(false);
  expect(transitions).toHaveBeenCalledTimes(4);
  activity.close();
});

it("streams activity separately from document versions and closes the stream on deletion", async () => {
  const store = await ReviewStore.open(":memory:", {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });

  const api = createReviewApi(store);

  const client = new ReviewApiClient(
    { serverUrl: "http://review.test", token: "test" },
    async (url, init) => api.request(url.replace("/reviews-api", ""), init),
  );

  const command = async <Operation>(operation: Operation) =>
    store.execute({ operation });

  const { reviewId } = await command({
    type: "create",
    title: "Activity",
    target: {
      kind: "commits",
      repositoryId: "repo",
      base: "base",
      head: "head",
    },
  });

  const changed = vi.fn<Parameters<ReviewStore["subscribe"]>[0]>();
  store.subscribe(changed);
  const abort = new AbortController();
  const stream = client.watch(reviewId, abort.signal);

  try {
    expect((await stream.next()).value).toMatchObject({
      activity: { workingCount: 0 },
    });

    const input = { focus: { description: "Drafting outline" } };

    const { activityId } = await client.post<{ activityId: string }>(
      `/${reviewId}/activity/begin`,
      input,
    );

    expect((await stream.next()).value).toMatchObject({
      activity: {
        workingCount: 1,
        activities: [{ activityId, slot: 0, focus: input.focus }],
      },
    });
    expect(changed).not.toHaveBeenCalled();
    expect(await store.history(reviewId)).toHaveLength(1);
    const reconnect = client.watch(reviewId, abort.signal);
    expect((await reconnect.next()).value).toMatchObject({
      activity: { workingCount: 1, activities: [{ focus: input.focus }] },
    });
    await reconnect.return(undefined);
    await store.execute({ operation: { type: "delete", reviewId } });
    // A reader may already have buffered a pre-deletion snapshot.
    await expect(async () => {
      for await (const _snapshot of stream) {
      }
    }).rejects.toThrow(Error);
    await expect(
      client.post(`/${reviewId}/activity/begin`, input),
    ).rejects.toThrow(/not found/i);
    expect((await store.activity.read(reviewId)).workingCount).toBe(0);
  } finally {
    abort.abort();
    await store.close();
  }
});

it("keeps each agent's focus until it changes, clears or expires", async () => {
  vi.useFakeTimers();
  const activity = await newActivity();
  const focus = { description: "Adding evidence", targetId: "section-1" };

  const mine = (
    await activity.update("review", {
      action: "begin",
      focus,
    })
  ).activityId!;

  const other = (
    await activity.update("review", {
      action: "begin",
      focus: { description: "Grouping files" },
    })
  ).activityId!;

  const focusOf = async (activityId: string) =>
    (await activity.read("review")).activities?.find(
      (presence) => presence.activityId === activityId,
    )?.focus;

  await activity.update("review", { action: "update", activityId: mine });
  expect(await focusOf(mine)).toEqual(focus);

  const next = { description: "Drawing save flow", targetId: "section-2" };
  await activity.update("review", {
    action: "update",
    activityId: mine,
    focus: next,
  });
  expect(await focusOf(mine)).toEqual(next);
  expect(await focusOf(other)).toEqual({ description: "Grouping files" });
  await activity.update("review", {
    action: "update",
    activityId: mine,
    focus: null,
  });
  expect(await focusOf(mine)).toBeUndefined();
  await activity.update("review", {
    action: "update",
    activityId: mine,
    focus,
  });
  await vi.advanceTimersByTimeAsync(ACTIVITY_TTL_MS);
  expect((await activity.read("review")).activities).toBeUndefined();
  activity.close();
});

it.each([false, true])(
  "streams completion and expiry to the catalog without an open canvas (multiplexed=%s)",
  async (multiplexed) => {
    vi.useFakeTimers();

    const store = await ReviewStore.open(":memory:", {
      validatePins: async () => {},
      validateSource: async () => {},
      validateResource: async () => {},
    });

    const api = createReviewApi(store);

    const { reviewId } = await store.execute({
      operation: {
        type: "create",
        title: "Background review",
        target: {
          kind: "commits",
          repositoryId: "repo",
          base: "base",
          head: "head",
        },
      },
    });

    const client = new ReviewApiClient(
      { serverUrl: "http://review.test", token: "test" },
      async (url, init) => api.request(url.replace("/reviews-api", ""), init),
    );

    const abort = new AbortController();

    const stream = client.watch(
      multiplexed ? [{ reviewId: null }] : null,
      abort.signal,
    );

    const next = async () => {
      const value = (await stream.next()).value;

      return multiplexed ? (value as { value: unknown }[])[0]!.value : value;
    };

    const expected = (working: boolean) => [
      expect.objectContaining({ reviewId, working }),
    ];

    try {
      expect(await next()).toEqual(expected(false));

      const { activityId } = await store.activity.update(reviewId, {
        action: "begin",
      });

      expect(await next()).toEqual(expected(true));
      // One line per transition: no repeat, nothing for renewals or focus.
      await store.activity.update(reviewId, {
        action: "update",
        activityId: activityId!,
      });
      await store.activity.update(reviewId, {
        action: "update",
        activityId: activityId!,
        focus: { description: "Reading the diff" },
      });
      await store.activity.update(reviewId, {
        action: "end",
        activityId: activityId!,
      });
      expect(await next()).toEqual(expected(false));
      await store.activity.update(reviewId, { action: "begin" });
      expect(await next()).toEqual(expected(true));
      await vi.advanceTimersByTimeAsync(ACTIVITY_TTL_MS);
      expect(await next()).toEqual(expected(false));
    } finally {
      abort.abort();
      await stream.return(undefined);
      await store.close();
    }
  },
);
