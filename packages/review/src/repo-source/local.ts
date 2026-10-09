import { realpath } from "node:fs/promises";

import type { RepoSource } from "./index.js";

/** Use the registered local checkout, preserving live working-tree reads. */
export function createLocalRepoSource(): RepoSource {
  return {
    async checkout({ repo }) {
      return { dir: await realpath(repo), dispose: async () => {} };
    },
  };
}
