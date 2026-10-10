import { describe, expect, it } from "vitest";

import {
  expandRangeWithContext,
  expandRangesWithContext,
  formatLineRangeLabel,
  isLineWithinRanges,
  lineRangeGaps,
  lineRangeLineCount,
  mergeLineRanges,
} from "./code-line-ranges";

describe("mergeLineRanges", () => {
  it("merges touching and overlapping ranges, sorted by start", () => {
    expect(
      mergeLineRanges([
        { startLine: 20, endLine: 24 },
        { startLine: 22, endLine: 23 },
        { startLine: 80, endLine: 82 },
        { startLine: 25, endLine: 26 },
      ]),
    ).toEqual([
      { startLine: 20, endLine: 26 },
      { startLine: 80, endLine: 82 },
    ]);
  });

  it("keeps a one-line gap between ranges unmerged", () => {
    expect(
      mergeLineRanges([
        { startLine: 1, endLine: 5 },
        { startLine: 7, endLine: 9 },
      ]),
    ).toEqual([
      { startLine: 1, endLine: 5 },
      { startLine: 7, endLine: 9 },
    ]);
  });

  it("returns an empty list for no ranges", () => {
    expect(mergeLineRanges([])).toEqual([]);
  });
});

describe("expandRangeWithContext", () => {
  it("widens by the context on both sides", () => {
    expect(expandRangeWithContext({ startLine: 10, endLine: 15 }, 5)).toEqual({
      startLine: 5,
      endLine: 20,
    });
  });

  it("clamps the start at the file's first line", () => {
    expect(expandRangeWithContext({ startLine: 2, endLine: 4 }, 5)).toEqual({
      startLine: 1,
      endLine: 9,
    });
  });

  it("clamps the end at a known file boundary", () => {
    expect(
      expandRangeWithContext({ startLine: 95, endLine: 98 }, 5, {
        maxLine: 100,
      }),
    ).toEqual({ startLine: 90, endLine: 100 });
  });

  it("leaves the end unbounded when the file length is unknown", () => {
    expect(expandRangeWithContext({ startLine: 95, endLine: 98 }, 5)).toEqual({
      startLine: 90,
      endLine: 103,
    });
  });
});

describe("expandRangesWithContext", () => {
  it("merges context windows that now overlap", () => {
    // Two selections 6 lines apart: +-5 context closes the gap between them.
    expect(
      expandRangesWithContext(
        [
          { startLine: 10, endLine: 12 },
          { startLine: 18, endLine: 20 },
        ],
        5,
      ),
    ).toEqual([{ startLine: 5, endLine: 25 }]);
  });

  it("keeps disjoint context windows separate", () => {
    expect(
      expandRangesWithContext(
        [
          { startLine: 10, endLine: 12 },
          { startLine: 40, endLine: 42 },
        ],
        5,
      ),
    ).toEqual([
      { startLine: 5, endLine: 17 },
      { startLine: 35, endLine: 47 },
    ]);
  });
});

describe("lineRangeGaps", () => {
  it("reports the hidden span between disjoint ranges", () => {
    expect(
      lineRangeGaps([
        { startLine: 5, endLine: 10 },
        { startLine: 42, endLine: 50 },
      ]),
    ).toEqual([{ afterIndex: 0, startLine: 11, endLine: 41 }]);
  });

  it("reports no gap for touching ranges", () => {
    expect(
      lineRangeGaps([
        { startLine: 5, endLine: 10 },
        { startLine: 11, endLine: 12 },
      ]),
    ).toEqual([]);
  });

  it("reports nothing for a single range", () => {
    expect(lineRangeGaps([{ startLine: 1, endLine: 3 }])).toEqual([]);
  });
});

describe("lineRangeLineCount", () => {
  it("sums inclusive line counts across ranges", () => {
    expect(
      lineRangeLineCount([
        { startLine: 1, endLine: 5 },
        { startLine: 10, endLine: 10 },
      ]),
    ).toBe(6);
  });
});

describe("isLineWithinRanges", () => {
  it("matches a line inside any range, inclusive of endpoints", () => {
    const ranges = [
      { startLine: 1, endLine: 5 },
      { startLine: 10, endLine: 12 },
    ];

    expect(isLineWithinRanges(1, ranges)).toBe(true);
    expect(isLineWithinRanges(5, ranges)).toBe(true);
    expect(isLineWithinRanges(7, ranges)).toBe(false);
    expect(isLineWithinRanges(12, ranges)).toBe(true);
    expect(isLineWithinRanges(13, ranges)).toBe(false);
  });
});

describe("formatLineRangeLabel", () => {
  it("formats a single line without a dash", () => {
    expect(formatLineRangeLabel([{ startLine: 7, endLine: 7 }])).toBe("7");
  });

  it("formats a range with a dash", () => {
    expect(formatLineRangeLabel([{ startLine: 12, endLine: 34 }])).toBe(
      "12-34",
    );
  });

  it("joins disjoint ranges with a comma", () => {
    expect(
      formatLineRangeLabel([
        { startLine: 12, endLine: 18 },
        { startLine: 42, endLine: 50 },
      ]),
    ).toBe("12-18, 42-50");
  });
});
