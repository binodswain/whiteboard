import { afterEach, expect, test } from "vitest";

import type { AuthoringTool } from "./agent-client.js";
import { ReviewApiClient } from "./client.js";
import { createReviewApi } from "./http.js";
import { callPublicTool, publicResult, publicTool } from "./public-tools.js";
import { ReviewStore } from "./store.js";

const stores: ReviewStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

test("public session tools create, edit and retry against the unchanged review store", async () => {
  const store = await ReviewStore.open(":memory:", {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });

  stores.push(store);
  const app = createReviewApi(store);

  const client = new ReviewApiClient(
    { serverUrl: "http://test", token: "test" },
    async (url, init) => app.request(url.replace("/reviews-api", ""), init),
  );

  const tools = (await client.read<AuthoringTool[]>("/authoring")).map(
    publicTool,
  );

  const call = (name: string, input: Parameters<typeof callPublicTool>[2]) =>
    callPublicTool(client, tools.find((tool) => tool.name === name)!, input);

  const create = await call("session_create", {
    title: "Public names",
    target: {
      kind: "commits",
      repositoryId: "repo",
      base: "base",
      head: "head",
    },
  });

  expect(create).toHaveProperty("sessionId");
  expect(create).not.toHaveProperty("reviewId");
  const sessionId = (await store.list())[0].reviewId;

  const literal =
    "Keep reviewId, sessionId and review_create verbatim in authored content.";

  const edit = {
    sessionId,
    edit: { type: "insert", content: { type: "markdown", markdown: literal } },
  };

  await call("session_edit", edit);
  expect((await store.read(sessionId)).version).toBe(1);
  expect(JSON.stringify((await store.read(sessionId)).document)).toContain(
    literal,
  );

  const snapshot = await call("session_get", {
    sessionId,
    format: "json",
    full: true,
  });

  expect(snapshot).toHaveProperty("sessionId", sessionId);
  expect(JSON.stringify(snapshot)).toContain(literal);
  await expect(call("session_get", { reviewId: sessionId })).rejects.toThrow(
    "Use sessionId",
  );
});

test("response translation leaves authored and arbitrary payload fields intact", () => {
  const document = {
    reviewId: "literal",
    review: { reviewId: "also literal" },
  };

  expect(
    publicResult({
      reviewId: "id",
      review: { reviewId: "id", document },
      document,
    }),
  ).toEqual({
    sessionId: "id",
    session: { sessionId: "id", document },
    document,
  });
});

test("job tools keep their public names and reviewId result fields", async () => {
  const statusTool = publicTool({
    name: "review_job_status",
    description: "Read review_job_status.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
    },
    method: "GET",
    path: "/jobs/:jobId",
  });

  const generateTool = publicTool({
    ...statusTool,
    name: "generate_review",
    method: "POST",
    path: "/jobs",
  });

  const client = new ReviewApiClient({ serverUrl: "http://test" }, async () =>
    Response.json({ reviewId: "review-1", url: "/r/review-1" }),
  );

  expect(statusTool.name).toBe("review_job_status");
  expect(generateTool.name).toBe("generate_review");
  await expect(
    callPublicTool(client, statusTool, { jobId: "job-1" }),
  ).resolves.toEqual({ reviewId: "review-1", url: "/r/review-1" });
});
