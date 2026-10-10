import type {
  StructuralFileRef,
  StructuralPairing,
  StructuralRegion,
  StructuralSource,
} from "@dev.fast/review-protocol";
import { describe, expect, it } from "vitest";

import {
  type StructuralTextDiff,
  buildWebDiffRows,
  hiddenFileLabel,
  seedFolds,
} from "./web-diff-rows";

const ref = (path: string): StructuralFileRef => ({
  path,
  oid: "0".repeat(40),
  mode: "100644",
});

const pos = (line: number, column = 0) => ({ line, column });

const leaf = (
  id: number,
  alignmentId: number,
  start: number,
  end: number,
): StructuralRegion => ({
  id,
  fold_state_id: id,
  alignment_id: alignmentId,
  kind: "leaf",
  start: pos(start),
  end: pos(end),
});

const fold = (
  id: number,
  children: StructuralRegion[],
  start: number,
  end: number,
  visibility?: { collapsed?: boolean; label?: string },
): StructuralRegion => {
  const region: StructuralRegion = {
    id,
    fold_state_id: id,
    kind: "fold",
    children,
    indent: pos(start, 2),
    start: pos(start),
    end: pos(end),
  };

  if (visibility) region.visibility = visibility;

  return region;
};

const source = (text: string, root: StructuralRegion): StructuralSource => ({
  text,
  root,
});

const filePair = (
  lhs: string,
  rhs: string,
): StructuralPairing<StructuralFileRef> => ({
  lhs: ref(lhs),
  rhs: ref(rhs),
});

const textDiff = (
  lhs: StructuralSource,
  rhs: StructuralSource,
  changes?: { base?: [number, number][]; head?: [number, number][] },
): StructuralTextDiff => ({
  type: "text",
  stats: {
    textual: { removed: 0, added: 0 },
    visible: { removed: 0, added: 0 },
  },
  structural_changes: { base: changes?.base ?? [], head: changes?.head ?? [] },
  lhs,
  rhs,
});

describe("buildWebDiffRows", () => {
  it("pairs aligned leaves line for line and marks changed lines", () => {
    const lhs = source("alpha\nbeta\n", fold(1, [leaf(2, 1, 0, 2)], 0, 3));
    const rhs = source("alpha\ngamma\n", fold(3, [leaf(4, 1, 0, 2)], 0, 3));

    const model = buildWebDiffRows({
      diff: textDiff(lhs, rhs, { base: [[1, 2]], head: [[1, 2]] }),
      file: filePair("a.ts", "a.ts"),
      collapsed: new Set(),
    });

    const lines = model.rows.filter((row) => row.type === "line");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      lhs: { text: "alpha", changed: false },
      rhs: { text: "alpha", changed: false },
    });
    expect(lines[1]).toMatchObject({
      lhs: { text: "beta", changed: true },
      rhs: { text: "gamma", changed: true },
    });
  });

  it("hides collapsed fold content behind an expand row", () => {
    // A two-line function fold inside the file; both sides share fold id 10.
    const inner = (leafId: number, alignmentId: number): StructuralRegion =>
      fold(10, [leaf(leafId, alignmentId, 0, 4)], 0, 4);

    const lhs = source(
      "fn f() {\n  a();\n  b();\n}\ntail\n",
      fold(1, [inner(2, 1), leaf(3, 2, 4, 5)], 0, 6),
    );

    const rhs = source(
      "fn f() {\n  a();\n  b();\n}\ntail\n",
      fold(4, [inner(5, 1), leaf(6, 2, 4, 5)], 0, 6),
    );

    const model = buildWebDiffRows({
      diff: textDiff(lhs, rhs),
      file: filePair("a.ts", "a.ts"),
      collapsed: new Set([10]),
    });

    const expand = model.rows.find((row) => row.type === "expand");

    expect(expand?.type).toBe("expand");

    const expandRow = expand && expand.type === "expand" ? expand : undefined;

    expect(expandRow?.foldId).toBe(10);

    expect(expandRow?.hidden).toHaveLength(3);

    expect(expandRow?.hidden[0]?.lhs?.text).toBe("  a();");

    // The fold's marker line stays visible on both sides.
    const markerLine = model.rows.find(
      (row) => row.type === "line" && row.lhs?.fold?.id === 10,
    );

    expect(markerLine).toMatchObject({
      lhs: { text: "fn f() {", fold: { collapsed: true } },
    });
  });

  it("collapses long unchanged runs to context plus an expand row", () => {
    // Twenty unchanged lines around one changed line near the middle: the
    // runs before and after it are longer than the kept context, so each
    // becomes an expand row.
    const make = (text: string, ids: [number, number][]): StructuralSource =>
      source(
        text,
        fold(
          1,
          ids.map(([id, alignment], index) =>
            leaf(id, alignment, index * 2, index * 2 + 2),
          ),
          0,
          42,
        ),
      );

    const linesL = Array.from({ length: 20 }, (_, index) => `l${index}`);
    linesL[10] = "old";
    const linesR = Array.from({ length: 20 }, (_, index) => `l${index}`);
    linesR[10] = "new";

    const ids: [number, number][] = Array.from(
      { length: 10 },
      (_, index) => [index + 10, index + 10] as [number, number],
    );

    const lhs = make(linesL.join("\n"), ids);
    const rhs = make(linesR.join("\n"), ids);

    const model = buildWebDiffRows({
      diff: textDiff(lhs, rhs, { base: [[10, 11]], head: [[10, 11]] }),
      file: filePair("a.ts", "a.ts"),
      collapsed: new Set(),
    });

    const expands = model.rows.filter((row) => row.type === "expand");

    // Two context collapses: the lines before and after the changed middle.
    expect(expands).toHaveLength(2);
    expect(
      model.rows.some(
        (row) =>
          row.type === "line" &&
          row.lhs?.text === "old" &&
          row.lhs.changed &&
          row.rhs?.text === "new" &&
          row.rhs.changed,
      ),
    ).toBe(true);
  });

  it("drops changed lines outside the lens so they fold into context", () => {
    const lhs = source("one\ntwo\n", fold(1, [leaf(2, 1, 0, 2)], 0, 3));
    const rhs = source("ONE\ntwo\n", fold(3, [leaf(4, 1, 0, 2)], 0, 3));

    const model = buildWebDiffRows({
      diff: textDiff(lhs, rhs, { base: [[0, 1]], head: [[0, 1]] }),
      file: filePair("a.ts", "a.ts"),
      collapsed: new Set(),
      lens: {
        id: "lens",
        title: "second line",
        reviewId: "review",
        version: 1,
        ranges: [
          { file: "a.ts", side: "base", fromLine: 2, toLine: 2 },
          { file: "a.ts", side: "head", fromLine: 2, toLine: 2 },
        ],
      },
    });

    const changed = model.rows.filter(
      (row) => row.type === "line" && (row.lhs?.changed || row.rhs?.changed),
    );

    expect(changed).toHaveLength(0);
  });
});

describe("seedFolds", () => {
  it("collects collapsed fold ids from either side", () => {
    const lhs = source(
      "a\n",
      fold(1, [], 0, 1, { collapsed: true, label: "region" }),
    );

    const rhs = source("a\n", fold(2, [], 0, 1));

    expect(seedFolds(textDiff(lhs, rhs))).toEqual(new Set([1]));
  });
});

describe("hiddenFileLabel", () => {
  const oneSided = (
    lhs: StructuralSource | undefined,
    rhs: StructuralSource | undefined,
  ): StructuralTextDiff =>
    lhs
      ? { type: "text" as const, stats, structural_changes, lhs }
      : { type: "text" as const, stats, structural_changes, rhs: rhs! };

  const stats = {
    textual: { removed: 0, added: 0 },
    visible: { removed: 0, added: 0 },
  };

  const structural_changes = { base: [], head: [] };

  it("names the file label when the root collapses", () => {
    const lhs = source(
      "x\n",
      fold(1, [], 0, 1, { collapsed: true, label: "generated" }),
    );

    expect(hiddenFileLabel(oneSided(lhs, undefined))).toBe("generated");
  });

  it("falls back to a default label without one", () => {
    const lhs = source("x\n", fold(1, [], 0, 1, { collapsed: true }));

    expect(hiddenFileLabel(oneSided(lhs, undefined))).toBe("Hidden by default");
  });
});
