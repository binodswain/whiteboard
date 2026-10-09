import { mkdir } from "node:fs/promises";
import path from "node:path";

import { withFileLock } from "@dev.fast/trace-core";

import { openLocalReviewStore } from "./local-data.js";
import { importHeadlessStore } from "./storage/sqlite.js";

const lockOptions = {
  retryMs: 50,
  timeoutMs: 10_000,
  staleMs: Infinity,
  unownedGraceMs: 1_000,
};

export async function openReviewProfile(
  home: string,
  options: { manageWorkspaces: boolean },
) {
  await mkdir(home, { recursive: true, mode: 0o700 });

  const outcome = await withFileLock(
    path.join(home, ".review-profile-startup"),
    lockOptions,
    async () => {
      for (const source of [
        path.join(home, "review-server", "reviews.db"),
        path.join(home, "reviews.db"),
      ])
        await importHeadlessStore(home, source, lockOptions);

      return openLocalReviewStore(path.join(home, "review-api.db"), options);
    },
  );

  if (!outcome.acquired)
    throw new Error(
      "Another Review process is initializing this profile. Retry shortly.",
    );

  return outcome.result;
}
