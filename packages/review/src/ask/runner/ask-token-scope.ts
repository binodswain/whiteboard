import { z } from "zod";

/** Read-only routes that describe how to author, not any review's content. */
const SHARED_READS = new Set([
  "authoring",
  "instructions",
  "capabilities",
  "status",
]);

/** Review routes an agent writes through: comments, progress and activity. */
const REVIEW_WRITES = new Set(["comments", "progress", "activity"]);

/** Review reads that would reach other agents or their transcripts. */
const REVIEW_READ_DENIED = new Set(["ask", "agent-traces"]);

/** Commands an agent may run on its own review: editing it, never creating,
 * retargeting, renaming or deleting one. */
const COMMAND_TYPES = new Set(["edit", "lens_edit"]);

/** Just enough of a command to tell which review it changes and how. */
const CommandBody = z.looseObject({
  operation: z.looseObject({
    type: z.string(),
    reviewId: z.string().optional(),
  }),
});

/**
 * Whether a per-ask token may make this request. The token is bound to one
 * review, so it reaches that review's reads and authoring writes and nothing
 * else: no other review, no listing, no queue, jobs or settings. `body` is the
 * parsed JSON body, read only for `POST /reviews-api/commands`.
 */
export function askTokenAllows(
  reviewId: string,
  request: { method: string; pathname: string; body?: unknown },
): boolean {
  if (!request.pathname.startsWith("/reviews-api/")) return false;

  let segments: string[];

  try {
    segments = request.pathname
      .slice("/reviews-api/".length)
      .split("/")
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return false;
  }

  const [first, second] = segments;
  const read = request.method === "GET" || request.method === "HEAD";

  if (segments.length === 1 && read && SHARED_READS.has(first)) return true;

  if (
    segments.length === 1 &&
    first === "commands" &&
    request.method === "POST"
  ) {
    const parsed = CommandBody.safeParse(request.body);

    return (
      parsed.success &&
      COMMAND_TYPES.has(parsed.data.operation.type) &&
      parsed.data.operation.reviewId === reviewId
    );
  }

  if (first !== reviewId) return false;

  if (read) return !second || !REVIEW_READ_DENIED.has(second);

  return request.method === "POST" && REVIEW_WRITES.has(second);
}
