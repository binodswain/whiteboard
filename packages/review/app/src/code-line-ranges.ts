/** Inclusive 1-based line range, independent of diff side or file identity. */
export interface LineRange {
  startLine: number;
  endLine: number;
}

/** A gap between two consecutive ranges in a sorted, merged list: the lines
 * hidden between `ranges[afterIndex]` and `ranges[afterIndex + 1]`. */
export interface LineRangeGap {
  afterIndex: number;
  startLine: number;
  endLine: number;
}

/** Sorts by start line and merges ranges that overlap or touch (no gap left
 * between them), the same adjacency rule CodePeek already uses to merge
 * authored selections before display. */
export function mergeLineRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine);
  const merged: LineRange[] = [];

  for (const range of sorted) {
    const previous = merged.at(-1);

    if (!previous || range.startLine > previous.endLine + 1) {
      merged.push({ ...range });
    } else {
      previous.endLine = Math.max(previous.endLine, range.endLine);
    }
  }

  return merged;
}

/** Widens one range by `context` lines on each side, clamped to `bounds`.
 * `bounds.maxLine` is omitted when the file's length is unknown (for
 * example the native surface, which lets its own editor clamp); the lower
 * bound is always known (a file starts at line 1). */
export function expandRangeWithContext(
  range: LineRange,
  context: number,
  bounds: { minLine?: number; maxLine?: number } = {},
): LineRange {
  const minLine = bounds.minLine ?? 1;
  const startLine = Math.max(minLine, range.startLine - context);
  const desiredEnd = range.endLine + context;

  const endLine =
    bounds.maxLine === undefined
      ? desiredEnd
      : Math.min(bounds.maxLine, desiredEnd);

  return { startLine, endLine: Math.max(startLine, endLine) };
}

/** Widens every range with context, then merges the (now possibly
 * overlapping) results back down — "Show surrounding context" for a
 * disjoint selection. */
export function expandRangesWithContext(
  ranges: readonly LineRange[],
  context: number,
  bounds: { minLine?: number; maxLine?: number } = {},
): LineRange[] {
  return mergeLineRanges(
    ranges.map((range) => expandRangeWithContext(range, context, bounds)),
  );
}

/** The hidden lines between consecutive ranges of an already-sorted, merged
 * list — one gap per boundary, for an "N lines hidden" divider. */
export function lineRangeGaps(ranges: readonly LineRange[]): LineRangeGap[] {
  const gaps: LineRangeGap[] = [];

  for (let index = 0; index < ranges.length - 1; index += 1) {
    const current = ranges[index]!;
    const next = ranges[index + 1]!;

    if (next.startLine > current.endLine + 1) {
      gaps.push({
        afterIndex: index,
        startLine: current.endLine + 1,
        endLine: next.startLine - 1,
      });
    }
  }

  return gaps;
}

export function lineRangeLineCount(ranges: readonly LineRange[]): number {
  return ranges.reduce(
    (total, range) => total + (range.endLine - range.startLine + 1),
    0,
  );
}

export function isLineWithinRanges(
  line: number,
  ranges: readonly LineRange[],
): boolean {
  return ranges.some(
    (range) => line >= range.startLine && line <= range.endLine,
  );
}

/** "12-34", "7" for a single line, or "12-18, 42-50" across disjoint ranges —
 * the compact card header's displayed range. */
export function formatLineRangeLabel(ranges: readonly LineRange[]): string {
  return ranges
    .map((range) =>
      range.startLine === range.endLine
        ? `${range.startLine}`
        : `${range.startLine}-${range.endLine}`,
    )
    .join(", ");
}

export function lineRangesEqual(
  left: readonly LineRange[],
  right: readonly LineRange[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (range, index) =>
        range.startLine === right[index]!.startLine &&
        range.endLine === right[index]!.endLine,
    )
  );
}
