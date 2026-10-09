import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { createLocalRepoSource } from "./local.js";

it("returns the registered local checkout path and leaves it in place on dispose", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-repo-source-"));

  try {
    const checkout = await createLocalRepoSource().checkout({
      repo: root,
      baseSha: "base",
      headSha: "head",
    });

    expect(checkout.dir).toBe(await realpath(root));
    await checkout.dispose();
    await expect(
      import("node:fs/promises").then(({ stat }) => stat(root)),
    ).resolves.toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
