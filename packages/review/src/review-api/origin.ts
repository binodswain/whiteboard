import { z } from "zod";

import type { MetadataStore } from "./storage/metadata-store.js";
import type { Snapshot } from "./store.js";

export const pullRequestUrl = z
  .string()
  .regex(
    /^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/,
    "Use a canonical GitHub PR URL: https://github.com/owner/repository/pull/123, or the same path on a GitHub Enterprise host.",
  )
  .refine(
    (url) => Number.isSafeInteger(Number(url.split("/").at(-1))),
    "PR number is too large.",
  );

/** One key per PR: GitHub owner and repository names are case-insensitive,
 * and the URL pattern admits only ASCII, so lowercasing is canonical. */
export function pullRequestKey(url: string): string {
  return url.toLowerCase();
}

/** Omission preserves identity; null detaches it without changing import metadata. */
export function setPullRequest(
  snapshot: Pick<Snapshot, "origin">,
  url: string | null | undefined,
) {
  if (url === undefined) return;

  if (url === null) {
    if (snapshot.origin) {
      delete snapshot.origin.pullRequestUrl;
      delete snapshot.origin.pullRequestNumber;
    }

    return;
  }

  snapshot.origin = {
    ...snapshot.origin,
    pullRequestUrl: url,
    pullRequestNumber: Number(url.split("/").at(-1)),
  };
}

/**
 * The review already made for this PR at this head, if any. Preparing a PR
 * head must find its earlier review rather than make another: a retried job
 * may have created one before its record of that was lost.
 */
export async function reviewIdForPullRequestHead(
  meta: MetadataStore,
  url: string,
  headSha: string,
): Promise<string | undefined> {
  const dialect = meta.dialect;

  const row = await meta.get<{ id: string }>(
    `SELECT reviews.id FROM reviews
     JOIN versions ON versions.review_id=reviews.id AND versions.version=reviews.version
     WHERE lower(${dialect.jsonText("versions.snapshot", "origin.pullRequestUrl")})=?
       AND reviews.head_sha=?
       AND NOT ${dialect.jsonFlag("versions.snapshot", "origin.tutorial")}
     ORDER BY reviews.rowid DESC LIMIT 1`,
    pullRequestKey(url),
    headSha,
  );

  return row ? String(row.id) : undefined;
}
