import { mkdir } from "node:fs/promises";
import path from "node:path";

import { withFileLock } from "@dev.fast/trace-core";
import type { DeploymentConfig } from "@review/server/deployment-config.js";

import { openLocalReviewStore } from "./local-data.js";
import {
  type MetadataStoreConfig,
  createMetadataStore,
} from "./storage/metadata-store.js";
import { importHeadlessStore } from "./storage/sqlite.js";

const lockOptions = {
  retryMs: 50,
  timeoutMs: 10_000,
  staleMs: Infinity,
  unownedGraceMs: 1_000,
};

export async function openReviewProfile(
  home: string,
  options: { manageWorkspaces: boolean; deployment?: DeploymentConfig },
) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const deployment = options.deployment;
  const metadataConfig = metadataStoreConfig(home, deployment);

  const outcome = await withFileLock(
    path.join(home, ".review-profile-startup"),
    lockOptions,
    async () => {
      if (metadataConfig.kind === "sqlite")
        for (const source of [
          path.join(home, "review-server", "reviews.db"),
          path.join(home, "reviews.db"),
        ])
          await importHeadlessStore(home, source, lockOptions);

      if (metadataConfig.kind === "postgres") {
        const metadataStore = await createMetadataStore(metadataConfig);

        try {
          return await openLocalReviewStore(metadataStore, options);
        } catch (error) {
          await metadataStore.close().catch(() => {});
          throw error;
        }
      }

      return openLocalReviewStore(metadataConfig.dir, options);
    },
  );

  if (!outcome.acquired)
    throw new Error(
      "Another Review process is initializing this profile. Retry shortly.",
    );

  return outcome.result;
}

export function metadataStoreConfig(
  home: string,
  deployment?: Pick<DeploymentConfig, "db" | "postgresUrl">,
): MetadataStoreConfig {
  if (deployment?.db === "postgres") {
    if (!deployment.postgresUrl)
      throw new Error("Postgres deployment requires WHITEBOARD_DB URL.");

    return { kind: "postgres", url: deployment.postgresUrl };
  }

  return { kind: "sqlite", dir: path.join(home, "review-api.db") };
}
