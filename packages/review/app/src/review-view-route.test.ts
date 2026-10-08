import { describe, expect, it } from "vitest";

import { offeredReviewViews } from "./review-view-route";

describe("offeredReviewViews", () => {
  it("keeps the complete desktop surface by default", () => {
    expect(
      offeredReviewViews({
        hasChangeRange: true,
        softwareMapEnabled: true,
        hasTraceSessions: true,
      }),
    ).toEqual(["review", "commits", "diff", "map", "trace"]);
  });

  it("limits web mode to the whiteboard and diagrams", () => {
    expect(
      offeredReviewViews({
        hasChangeRange: true,
        softwareMapEnabled: true,
        hasTraceSessions: true,
        surface: "web",
      }),
    ).toEqual(["review", "map"]);
  });
});
