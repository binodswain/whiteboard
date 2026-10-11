import { readdir } from "node:fs/promises";
import path from "node:path";

import { git } from "@dev.fast/local-vcs";
import { withFileLock } from "@dev.fast/trace-core";

/**
 * Compacts each cached GitHub clone under `root` (`<owner>/<repo>`): drops
 * worktree registrations whose directories are gone and lets git pack loose
 * objects. Clones are kept, since reviews read from them. Each runs under the
 * clone's preparation lock, so it never races a checkout; a busy clone is
 * skipped until the next pass.
 */
export async function maintainRepoCaches(
  root: string,
  log: (message: string) => void = () => {},
): Promise<void> {
  const dirs = async (dir: string) =>
    (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));

  for (const owner of await dirs(root))
    for (const clone of await dirs(owner)) {
      const locked = await withFileLock(
        `${clone}.lock`,
        {
          retryMs: 100,
          timeoutMs: 1_000,
          staleMs: 120_000,
          heartbeatMs: 5_000,
          unownedGraceMs: 1_000,
        },
        async () => {
          await git(clone, ["worktree", "prune"], { allowFailure: true });
          await git(clone, ["gc", "--auto", "--quiet"], { allowFailure: true });
        },
      ).catch((cause: unknown) => {
        log(`cache maintenance of ${clone} failed: ${String(cause)}`);

        return undefined;
      });

      if (locked && !locked.acquired)
        log(`cache maintenance skipped busy ${clone}`);
    }
}
