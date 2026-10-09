import { z } from "zod";

const baseUrl = (
  process.env.WHITEBOARD_URL ??
  `http://127.0.0.1:${process.env.WHITEBOARD_PORT ?? "7421"}`
).replace(/\/$/, "");

const proxyLogin =
  process.env.WHITEBOARD_SMOKE_GITHUB_USER ?? "whiteboard-smoke";

const proxySecret =
  process.env.WHITEBOARD_AUTH_PROXY_SECRET ?? "remote-dev-proxy-secret";

const proxyHeader =
  process.env.WHITEBOARD_AUTH_PROXY_HEADER ?? "x-whiteboard-user";

const proxySecretHeader =
  process.env.WHITEBOARD_AUTH_PROXY_SECRET_HEADER ??
  "x-whiteboard-proxy-secret";

const repo = process.env.WHITEBOARD_SMOKE_REPOSITORY ?? "octocat/Hello-World";

const githubToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      [proxyHeader]: proxyLogin,
      [proxySecretHeader]: proxySecret,
      ...options.headers,
    },
  });

  const body = await response.json().catch(() => undefined);

  if (!response.ok)
    throw new Error(
      `${options.method ?? "GET"} ${path}: ${response.status} ${JSON.stringify(body)}`,
    );

  return body;
}

const healthResponse = await fetch(`${baseUrl}/health`);

const health = await healthResponse.json();

if (!healthResponse.ok || health.deployment?.mode !== "remote")
  throw new Error(
    `Expected remote mode at ${baseUrl}/health, received ${JSON.stringify(health)}`,
  );

const tokenResponse = await fetch(`${baseUrl}/auth/tokens`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    [proxyHeader]: proxyLogin,
    [proxySecretHeader]: proxySecret,
  },
  body: JSON.stringify({ name: "remote deployment smoke" }),
});

const tokenBody = z
  .object({ token: z.string().min(1) })
  .safeParse(await tokenResponse.json().catch(() => undefined));

if (!tokenResponse.ok || !tokenBody.success)
  throw new Error(
    `Could not mint a smoke API token: ${tokenResponse.status} ${JSON.stringify(tokenBody)}`,
  );

const token = tokenBody.data.token;

const githubHeaders = {
  accept: "application/vnd.github+json",
  "user-agent": "whiteboard-remote-smoke",
};

if (githubToken) githubHeaders.authorization = `Bearer ${githubToken}`;

const commitsResponse = await fetch(
  `https://api.github.com/repos/${repo}/commits?per_page=1`,
  { headers: githubHeaders },
);

if (!commitsResponse.ok)
  throw new Error(`GitHub commit lookup failed: ${commitsResponse.status}`);

const [headCommit] = await commitsResponse.json();

const baseSha = headCommit?.parents?.[0]?.sha;

const headSha = headCommit?.sha;

if (!baseSha || !headSha)
  throw new Error(`Repository ${repo} needs at least one commit with a parent`);

const submitted = await request("/reviews-api/jobs", {
  method: "POST",
  body: JSON.stringify({
    repository: `https://github.com/${repo}.git`,
    base: baseSha,
    head: headSha,
  }),
});

if (!submitted.jobId) throw new Error("Review job response has no jobId");

const deadline = Date.now() + 120_000;

let created;

while (Date.now() < deadline) {
  const job = await request(
    `/reviews-api/jobs/${encodeURIComponent(submitted.jobId)}`,
  );

  if (job.status === "succeeded" && job.reviewId) {
    created = job;
    break;
  }

  if (job.status === "failed")
    throw new Error(
      `Review preparation failed: ${job.error ?? "unknown error"}`,
    );

  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

if (!created?.reviewId)
  throw new Error(
    `Review job ${submitted.jobId} did not finish in 120 seconds`,
  );

const comment = await request(
  `/reviews-api/${encodeURIComponent(created.reviewId)}/comments`,
  {
    method: "POST",
    body: JSON.stringify({
      body: "Remote deployment smoke comment",
      author: proxyLogin,
    }),
  },
);

if (!comment.id) throw new Error("Comment create response has no id");

const queued = await request("/reviews-api/asks", {
  method: "POST",
  body: JSON.stringify({
    reviewId: created.reviewId,
    prompt: "Remote deployment ask queue smoke",
    createdBy: proxyLogin,
  }),
});

if (!queued.askId) throw new Error("Ask enqueue response has no askId");

const runnerId = `smoke-${process.pid}`;

await request(`/reviews-api/asks/${encodeURIComponent(queued.askId)}/claim`, {
  method: "POST",
  body: JSON.stringify({ runnerId }),
});

await request(
  `/reviews-api/asks/${encodeURIComponent(queued.askId)}/complete`,
  {
    method: "POST",
    body: JSON.stringify({ runnerId, resultRefs: [] }),
  },
);

console.log(
  JSON.stringify({
    mode: health.deployment.mode,
    reviewId: created.reviewId,
    commentId: comment.id,
    askId: queued.askId,
  }),
);
