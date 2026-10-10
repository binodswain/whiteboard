import { describe, expect, it, vi } from "vitest";

import { type RepoAccess, canReadRepository } from "./index.js";

describe("queued job repository principal", () => {
  it("can read only the repository that owns its job", async () => {
    const canRead = vi.fn<() => Promise<boolean>>(async () => false);

    const access: RepoAccess = {
      canRead,
      normalize: (repo) =>
        repo.startsWith("https://github.com/") ? repo : undefined,
    };

    const principal = {
      id: "proxy:smoke-user",
      login: "smoke-user",
      via: "job" as const,
      jobRepository: "https://github.com/octocat/Hello-World",
      jobCheckoutPath: "/tmp/whiteboard-repo-owned-by-job",
    };

    await expect(
      canReadRepository(
        principal,
        "https://github.com/octocat/Hello-World",
        access,
      ),
    ).resolves.toBe(true);
    await expect(
      canReadRepository(
        principal,
        "https://github.com/octocat/Spoon-Knife",
        access,
      ),
    ).resolves.toBe(false);
    await expect(
      canReadRepository(principal, "/tmp/another-repository", access),
    ).resolves.toBe(false);
    expect(canRead).not.toHaveBeenCalled();
  });
});
