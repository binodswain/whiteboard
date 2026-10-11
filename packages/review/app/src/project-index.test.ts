import type { ReviewApiSummary } from "@dev.fast/review-protocol";
import { describe, expect, it } from "vitest";

import {
  PROJECT_INDEX_START_GRACE_MS,
  projectIndexState,
  projectIndexTitle,
} from "./project-index";

const repository = { id: "repo-1", name: "api" };

function session(overrides: Partial<ReviewApiSummary> = {}): ReviewApiSummary {
  return {
    reviewId: "r1",
    version: 1,
    title: projectIndexTitle(repository),
    createdAt: "2026-10-11T10:00:00Z",
    repositoryName: "api",
    viewedAt: null,
    dismissedAt: null,
    target: { kind: "worktree", repositoryId: "repo-1" },
    ...overrides,
  };
}

const t0 = Date.parse("2026-10-11T10:00:00Z");

const started = (knownIds: string[] = []) => ({
  at: t0,
  knownIds: new Set(knownIds),
});

describe("projectIndexState", () => {
  it("is none before anything ran", () => {
    expect(projectIndexState(repository, [], undefined, t0).status).toBe(
      "none",
    );
  });

  it("covers the gap between the click and the catalog update", () => {
    expect(
      projectIndexState(repository, [], started(), t0 + 1_000).status,
    ).toBe("starting");
  });

  it("does not stay starting forever when nothing appears", () => {
    expect(
      projectIndexState(
        repository,
        [],
        started(),
        t0 + PROJECT_INDEX_START_GRACE_MS + 1,
      ).status,
    ).toBe("none");
  });

  it("is running while an agent holds the session", () => {
    expect(
      projectIndexState(
        repository,
        [session({ working: true })],
        started(),
        t0 + 5_000,
      ).status,
    ).toBe("running");
  });

  it("is ready once the agent lets go", () => {
    expect(
      projectIndexState(repository, [session()], started(), t0 + 60_000).status,
    ).toBe("ready");
  });

  it("starts again over an older finished index", () => {
    const old = session({ reviewId: "old" });

    expect(
      projectIndexState(repository, [old], started(["old"]), t0 + 1_000).status,
    ).toBe("starting");
  });

  it("ignores a dismissed index and other repositories' indexes", () => {
    const other = session({
      target: { kind: "worktree", repositoryId: "repo-2" },
    });

    const dismissed = session({ dismissedAt: "2026-10-11T11:00:00Z" });

    expect(
      projectIndexState(repository, [other, dismissed], undefined, t0).status,
    ).toBe("none");
  });
});
