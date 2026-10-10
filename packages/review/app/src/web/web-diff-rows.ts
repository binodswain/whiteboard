import type {
  ReviewDiffLens,
  StructuralDiff,
  StructuralFileRef,
  StructuralPairing,
  StructuralRegion,
  StructuralSource,
} from "@dev.fast/review-protocol";
import { structuralRows } from "@dev.fast/review-protocol";

export type StructuralTextDiff = Extract<StructuralDiff, { type: "text" }>;

/** One rendered half-line; `number` is 1-based for the gutter. */
export interface WebDiffLine {
  line: number;
  number: number;
  text: string;
  changed: boolean;
  /** Inline changed spans, 0-based UTF-16 columns. */
  spans: { start: number; end: number }[];
  /** The fold this line opens, when it is the marker line of a region. */
  fold?: { id: number; collapsed: boolean; label?: string };
}

export type WebDiffRow =
  | { type: "line"; lhs?: WebDiffLine; rhs?: WebDiffLine }
  | {
      type: "expand";
      /** The aligned lines the marker hides; expanding renders them. */
      hidden: WebDiffLinePair[];
      label?: string;
      /** The collapsed fold this expands; absent for plain context. */
      foldId?: number;
    };

type WebDiffLinePair = { lhs?: WebDiffLine; rhs?: WebDiffLine };

export interface WebDiffModel {
  rows: WebDiffRow[];
  /** The file's path on the head side (renames keep their new name). */
  path: string;
}

type Leaf = Extract<StructuralRegion, { kind: "leaf" }>;

const CONTEXT = 3;

/** The 0-based, half-open line span a region touches. */
function regionLines(region: StructuralRegion) {
  return {
    start: region.start.line,
    end: region.end.column === 0 ? region.end.line : region.end.line + 1,
  };
}

function walkRegions(
  region: StructuralRegion | undefined,
  visit: (region: StructuralRegion) => void,
): void {
  if (!region) return;

  visit(region);

  if (region.kind === "fold")
    for (const child of region.children) walkRegions(child, visit);
}

/** The head path when present, else the base path (deletions). */
export function structuralFilePath(
  file: StructuralPairing<StructuralFileRef>,
): string {
  return file.rhs?.path ?? file.lhs?.path ?? "";
}

/** Byte columns on the wire become UTF-16 columns for DOM spans. */
function byteToCharIndex(line: string): readonly number[] {
  const encoder = new TextEncoder();

  const bytes = encoder.encode(line);

  const map = new Array<number | undefined>(bytes.length + 1);

  let byte = 0;

  let char = 0;

  map[0] = 0;

  for (const codePoint of line) {
    byte += encoder.encode(codePoint).length;
    char += codePoint.length;

    map[Math.min(byte, bytes.length)] = char;
  }

  let last = 0;

  const filled = map.map((value) => {
    if (value !== undefined) last = value;

    return last;
  });

  return filled;
}

function collectLeaves(root: StructuralRegion | undefined): Leaf[] {
  const leaves: Leaf[] = [];

  const walk = (region: StructuralRegion) => {
    if (region.kind === "leaf") leaves.push(region);
    else for (const child of region.children) walk(child);
  };

  if (root) walk(root);

  return leaves;
}

/**
 * Seed fold collapse state from the wire. Both sides share `fold_state_id`,
 * so one map drives linked folds, mirroring the desktop session.
 */
export function seedFolds(diff: StructuralTextDiff): Set<number> {
  const collapsed = new Set<number>();

  for (const side of [diff.lhs, diff.rhs])
    walkRegions(side?.root, (region) => {
      if (collapsed.has(region.fold_state_id)) return;

      if (region.visibility?.collapsed === true)
        collapsed.add(region.fold_state_id);
    });

  return collapsed;
}

/** Whether diffr collapsed the whole file, and the label it gave. */
export function hiddenFileLabel(diff: StructuralDiff): string | undefined {
  if (diff.type !== "text") return undefined;

  const visibility = [diff.rhs, diff.lhs].find(
    (side) => side?.root.visibility?.collapsed,
  )?.root.visibility;

  return visibility ? (visibility.label ?? "Hidden by default") : undefined;
}

/**
 * Align both sides of a structural diff into renderable rows: paired lines
 * line up, one-sided leaves leave a gap, collapsed folds hide their lines
 * behind an expand marker, and long unchanged runs collapse to context.
 * A lens drops changed lines outside its ranges from the changed set, so
 * they fold away like ordinary context.
 */
export function buildWebDiffRows(input: {
  diff: StructuralTextDiff;
  file: StructuralPairing<StructuralFileRef>;
  /** The fold_state_ids currently collapsed. */
  collapsed: ReadonlySet<number>;
  lens?: ReviewDiffLens;
}): WebDiffModel {
  const { diff, file, collapsed, lens } = input;

  const lhsLines = (diff.lhs?.text ?? "").split("\n");

  const rhsLines = (diff.rhs?.text ?? "").split("\n");

  const lhsBytes = lhsLines.map(byteToCharIndex);

  const rhsBytes = rhsLines.map(byteToCharIndex);

  // Changed lines per side, narrowed to the lens when it names ranges.
  const sideChanged = (side: "base" | "head"): Set<number> => {
    const ranges = diff.structural_changes[side];

    const path = side === "base" ? file.lhs?.path : file.rhs?.path;

    const keep = new Set<number>();

    for (const [start, end] of ranges) {
      for (let line = start; line < end; line++) {
        if (
          lens === undefined ||
          path === undefined ||
          lens.ranges.some(
            (range) =>
              range.side === side &&
              range.file === path &&
              line >= range.fromLine - 1 &&
              line < range.toLine,
          )
        )
          keep.add(line);
      }
    }

    return keep;
  };

  const lhsChanged = sideChanged("base");

  const rhsChanged = sideChanged("head");

  // Leaf changed spans per side and line, in UTF-16 columns.
  const sideSpans = (
    source: StructuralSource | undefined,
    bytes: readonly (readonly number[])[],
  ): { start: number; end: number }[][] => {
    const spans: { start: number; end: number }[][] = bytes.map(() => []);

    if (!source) return spans;

    for (const leaf of collectLeaves(source.root))
      for (const span of leaf.changed ?? []) {
        const row = spans[span.line];

        const map = bytes[span.line];

        if (row && map) {
          const start = map[Math.min(span.start_column, map.length - 1)] ?? 0;

          const end = map[Math.min(span.end_column, map.length - 1)] ?? 0;

          if (end > start) row.push({ start, end });
        }
      }

    return spans;
  };

  const lhsSpans = sideSpans(diff.lhs, lhsBytes);

  const rhsSpans = sideSpans(diff.rhs, rhsBytes);

  interface Hide {
    hidden: boolean;
    foldId?: number;
    label?: string;
  }

  // A line hides when a collapsed fold on its side covers it; the fold's own
  // start line stays as the marker. The innermost hiding fold's label names
  // the expander, and its id is what expanding clears.
  const sideHidden = (
    source: StructuralSource | undefined,
    count: number,
  ): Hide[] => {
    const hidden: Hide[] = new Array(count)
      .fill(undefined)
      .map(() => ({ hidden: false }));

    if (!source) return hidden;

    walkRegions(source.root, (region) => {
      if (region === source.root) return;

      if (!collapsed.has(region.fold_state_id)) return;

      const { start, end } = regionLines(region);

      for (let line = start + 1; line < end && line < count; line++)
        hidden[line] = {
          hidden: true,
          foldId: region.fold_state_id,
          label: region.visibility?.label,
        };
    });

    return hidden;
  };

  const lhsHidden = sideHidden(diff.lhs, lhsLines.length);

  const rhsHidden = sideHidden(diff.rhs, rhsLines.length);

  // The smallest region starting on a line gets the fold marker, so nested
  // folds keep their own marker lines.
  const sideMarkers = (
    source: StructuralSource | undefined,
    count: number,
  ): (StructuralRegion | undefined)[] => {
    const markers: (StructuralRegion | undefined)[] = new Array(count);

    if (!source) return markers;

    walkRegions(source.root, (region) => {
      if (region === source.root) return;

      const { start, end } = regionLines(region);

      const existing = markers[start];

      if (
        start < count &&
        (!existing ||
          regionLines(existing).end - regionLines(existing).start > end - start)
      )
        markers[start] = region;
    });

    return markers;
  };

  const lhsMarkers = sideMarkers(diff.lhs, lhsLines.length);

  const rhsMarkers = sideMarkers(diff.rhs, rhsLines.length);

  const marker = (region: StructuralRegion | undefined): WebDiffLine["fold"] =>
    region === undefined
      ? undefined
      : {
          id: region.fold_state_id,
          collapsed: collapsed.has(region.fold_state_id),
          label: region.visibility?.label,
        };

  const makeLine = (
    lines: string[],
    line: number,
    changed: boolean,
    spans: { start: number; end: number }[],
    region: StructuralRegion | undefined,
  ): WebDiffLine => ({
    line,
    number: line + 1,
    text: lines[line] ?? "",
    changed,
    spans,
    fold: marker(region),
  });

  // Emit aligned lines, collecting both-sides-hidden rows into an expander.
  const emitted: WebDiffRow[] = [];

  let run: WebDiffLinePair[] = [];

  let runLabel: string | undefined;

  let runFold: number | undefined;

  const flushHidden = () => {
    if (run.length > 0)
      emitted.push({
        type: "expand",
        hidden: run,
        label: runLabel,
        foldId: runFold,
      });

    run = [];

    runLabel = undefined;

    runFold = undefined;
  };

  for (const [left, right] of structuralRows(diff)) {
    const lhsHide = left !== null ? lhsHidden[left] : undefined;

    const rhsHide = right !== null ? rhsHidden[right] : undefined;

    if (
      (left === null || lhsHide?.hidden === true) &&
      (right === null || rhsHide?.hidden === true)
    ) {
      const hidden: WebDiffLinePair = {};

      if (left !== null)
        hidden.lhs = makeLine(
          lhsLines,
          left,
          lhsChanged.has(left),
          lhsSpans[left] ?? [],
          lhsMarkers[left],
        );

      if (right !== null)
        hidden.rhs = makeLine(
          rhsLines,
          right,
          rhsChanged.has(right),
          rhsSpans[right] ?? [],
          rhsMarkers[right],
        );

      run.push(hidden);
      runFold ??= lhsHide?.foldId ?? rhsHide?.foldId;
      runLabel ??= lhsHide?.label ?? rhsHide?.label;

      continue;
    }

    flushHidden();

    // A side folded away keeps the other's lines visible against its gap.
    const pair: WebDiffLinePair = {};

    if (left !== null && lhsHide?.hidden !== true)
      pair.lhs = makeLine(
        lhsLines,
        left,
        lhsChanged.has(left),
        lhsSpans[left] ?? [],
        lhsMarkers[left],
      );

    if (right !== null && rhsHide?.hidden !== true)
      pair.rhs = makeLine(
        rhsLines,
        right,
        rhsChanged.has(right),
        rhsSpans[right] ?? [],
        rhsMarkers[right],
      );

    emitted.push({ type: "line", ...pair });
  }

  // Collapse long unchanged runs, keeping CONTEXT lines at each edge — the
  // same shape Monaco's unchanged-region folding takes.
  const rows: WebDiffRow[] = [];

  let context: WebDiffLinePair[] = [];

  const flushContext = () => {
    if (context.length > CONTEXT * 2 + 1) {
      rows.push(...context.slice(0, CONTEXT).map(pairAsRow));

      rows.push({
        type: "expand",
        hidden: context.slice(CONTEXT, context.length - CONTEXT),
      });

      rows.push(...context.slice(context.length - CONTEXT).map(pairAsRow));
    } else rows.push(...context.map(pairAsRow));

    context = [];
  };

  const pairAsRow = (pair: {
    lhs?: WebDiffLine;
    rhs?: WebDiffLine;
  }): WebDiffRow => ({ type: "line", ...pair });

  for (const row of emitted) {
    const unchanged =
      row.type === "line" &&
      row.lhs !== undefined &&
      row.rhs !== undefined &&
      !row.lhs.changed &&
      !row.rhs.changed;

    if (unchanged) {
      context.push({
        ...(row.lhs && { lhs: row.lhs }),
        ...(row.rhs && { rhs: row.rhs }),
      });

      continue;
    }

    flushContext();

    rows.push(row);
  }

  flushContext();

  return { rows, path: structuralFilePath(file) };
}
