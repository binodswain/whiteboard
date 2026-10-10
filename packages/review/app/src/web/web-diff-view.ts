import type {
  ReviewCommitScope,
  ReviewDiffFileWire,
  ReviewDiffLayout,
  ReviewDiffProgress,
  ReviewDiffViewFactory,
  ReviewDiffViewHandle,
  ReviewDiffViewSpec,
  ReviewDisposable,
  ReviewStructuralDiffEvent,
  StructuralDiff,
  StructuralFileRef,
  StructuralPairing,
  StructuralRegion,
} from "@dev.fast/review-protocol";

import {
  type WebDiffLine,
  type WebDiffRow,
  buildWebDiffRows,
  hiddenFileLabel,
  seedFolds,
  structuralFilePath,
} from "./web-diff-rows";

/** The transport the bridge wires: file listings and the diffr stream. */
export interface WebDiffViewSource {
  files(
    scope: ReviewCommitScope | undefined,
    patch: boolean,
  ): Promise<readonly ReviewDiffFileWire[]>;

  structural(
    query: { version?: number; commit?: string },
    signal: AbortSignal,
  ): AsyncIterable<ReviewStructuralDiffEvent>;
}

export interface WebDiffViewOptions {
  source: WebDiffViewSource;
  /** Structural rendering follows the web setting at mount time. */
  structural: () => boolean;
  layout: () => ReviewDiffLayout;

  onDidChangeLayout(
    listener: (layout: ReviewDiffLayout) => void,
  ): ReviewDisposable;
  codeFontSize?: () => number | undefined;
  /** The document version the canvas shows; undefined asks for current. */
  sourceVersion?: () => number | undefined;
}

interface FileSection {
  path: string;
  status: string;
  section: HTMLElement;
  body: HTMLElement;
  counts: HTMLElement;
  caret: HTMLElement;
  viewed?: HTMLInputElement;
  diff?: StructuralDiff;
  file?: StructuralPairing<StructuralFileRef>;
  folds?: Set<number>;
  /** Whether the reader opened a collapsed-by-default file. */
  opened?: boolean;
  error?: string;
}

const CSS = `
.wb-diff { font: 12px/1.5 var(--font-mono, ui-monospace, monospace); color: var(--ink); height: 100%; overflow: auto; }
.wb-diff-status { padding: 12px 16px; color: var(--ink-muted); font: 12px/1.5 inherit; }
.wb-file { border-bottom: 1px solid var(--rule); }
.wb-file-head { display: flex; align-items: center; gap: 8px; padding: 6px 12px; position: sticky; top: 0; background: var(--tray); border-block: 1px solid var(--rule); cursor: pointer; user-select: none; z-index: 1; }
.wb-file-head:hover { background: var(--tray-raised); }
.wb-file-caret { color: var(--ink-faint); width: 12px; }
.wb-file-path { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.wb-file-status { color: var(--ink-faint); font-size: 11px; }
.wb-file-counts { margin-left: auto; white-space: nowrap; font-size: 11px; }
.wb-file-counts .add { color: var(--diff-added); }
.wb-file-counts .del { color: var(--diff-removed); }
.wb-file-viewed { accent-color: var(--accent, #5b7cff); }
.wb-file-note { padding: 8px 16px; color: var(--ink-muted); }
.wb-file-error { padding: 8px 16px; color: var(--diff-removed); white-space: pre-wrap; }
.wb-table { display: grid; width: 100%; }
.wb-row { display: contents; }
.wb-row.unified { display: block; }
.wb-half { display: flex; min-width: 0; }
.wb-half.gap { background: transparent; }
.wb-num { flex: 0 0 3.5ch; text-align: right; padding: 0 6px; color: var(--ink-faint); user-select: none; }
.wb-fold { flex: 0 0 1.4ch; color: var(--ink-muted); cursor: pointer; user-select: none; }
.wb-code { flex: 1 1 auto; white-space: pre; padding-right: 12px; }
.wb-half.changed-lhs { background: var(--diff-removed-bg); }
.wb-half.changed-rhs { background: var(--diff-added-bg); }
.wb-half.changed-lhs .wb-num { color: var(--diff-removed); }
.wb-half.changed-rhs .wb-num { color: var(--diff-added); }
.wb-half.changed-lhs .wb-span { background: color-mix(in srgb, var(--diff-removed) 30%, transparent); }
.wb-half.changed-rhs .wb-span { background: color-mix(in srgb, var(--diff-added) 30%, transparent); }
.wb-span { border-radius: 2px; }
.wb-expand { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; padding: 2px 12px; color: var(--ink-muted); background: color-mix(in srgb, var(--ink) 4%, transparent); cursor: pointer; user-select: none; border: 0; width: 100%; font: inherit; text-align: left; }
.wb-expand:hover { color: var(--ink); background: color-mix(in srgb, var(--ink) 8%, transparent); }
.wb-expand.static { cursor: default; font-style: italic; }
.wb-expand.static:hover { color: var(--ink-muted); background: color-mix(in srgb, var(--ink) 4%, transparent); }
.wb-file.collapsed > .wb-file-body { display: none; }
.wb-file.collapsed > .wb-file-head .wb-file-caret { transform: none; }
.wb-tree { display: flex; flex-direction: column; }
.wb-tree button { display: flex; align-items: center; gap: 8px; padding: 4px 12px; background: none; border: 0; color: var(--ink); font: inherit; text-align: left; cursor: pointer; }
.wb-tree button:hover { background: var(--tray-raised); }
.wb-tree .wb-file-counts { margin-left: auto; }
.wb-flash { animation: wb-flash 1.2s ease-out; }
@keyframes wb-flash { 0% { background: color-mix(in srgb, var(--accent, #5b7cff) 25%, transparent); } 100% { background: transparent; } }
.wb-diff .is-viewed > .wb-file-head .wb-file-path,
.wb-diff .is-viewed > .wb-file-head .wb-file-counts { opacity: 0.55; }
`;

const STATUS_LABELS = new Map([
  ["added", "A"],
  ["modified", "M"],
  ["deleted", "D"],
  ["renamed", "R"],
  ["copied", "C"],
  ["type_changed", "T"],
]);

/** Parse one file's Git patch into aligned rows (textual fallback). */
function patchRows(patch: string): WebDiffRow[] {
  const rows: WebDiffRow[] = [];

  const lines = patch.split("\n");

  let lhs = 0,
    rhs = 0,
    inHunk = false;

  for (const raw of lines) {
    if (raw.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw);

      if (match) {
        lhs = Number(match[1]);

        rhs = Number(match[2]);

        inHunk = true;

        rows.push({ type: "expand", hidden: [], label: raw });
      }

      continue;
    }

    if (!inHunk) continue;

    if (raw.startsWith("-")) {
      rows.push({
        type: "line",
        lhs: {
          line: lhs - 1,
          number: lhs++,
          text: raw.slice(1),
          changed: true,
          spans: [],
        },
      });

      continue;
    }

    if (raw.startsWith("+")) {
      const added: WebDiffLine = {
        line: rhs - 1,
        number: rhs++,
        text: raw.slice(1),
        changed: true,
        spans: [],
      };

      const last = rows[rows.length - 1];

      if (last?.type === "line" && last.lhs && !last.rhs) last.rhs = added;
      else rows.push({ type: "line", rhs: added });

      continue;
    }

    if (raw.startsWith("\\")) continue;

    const text = raw.startsWith(" ") ? raw.slice(1) : raw;

    rows.push({
      type: "line",
      lhs: { line: lhs - 1, number: lhs++, text, changed: false, spans: [] },
      rhs: { line: rhs - 1, number: rhs++, text, changed: false, spans: [] },
    });
  }

  return rows;
}

function textWithSpans(
  document: Document,
  line: WebDiffLine,
): DocumentFragment {
  const fragment = document.createDocumentFragment();

  if (line.spans.length === 0) {
    fragment.append(line.text);

    return fragment;
  }

  let cursor = 0;

  for (const span of [...line.spans].sort((a, b) => a.start - b.start)) {
    if (span.start > cursor)
      fragment.append(line.text.slice(cursor, span.start));

    const mark = document.createElement("span");

    mark.className = "wb-span";

    mark.textContent = line.text.slice(span.start, span.end);

    fragment.append(mark);

    cursor = Math.max(cursor, span.end);
  }

  if (cursor < line.text.length) fragment.append(line.text.slice(cursor));

  return fragment;
}

/** Diff the middles of paired changed lines for word-level marks. */
function pairSpans(lhs: WebDiffLine, rhs: WebDiffLine): void {
  if (!lhs.changed || !rhs.changed) return;

  if (lhs.spans.length || rhs.spans.length) return;

  let start = 0;

  const min = Math.min(lhs.text.length, rhs.text.length);

  while (start < min && lhs.text[start] === rhs.text[start]) start++;

  let lhsEnd = lhs.text.length,
    rhsEnd = rhs.text.length;

  while (
    lhsEnd > start &&
    rhsEnd > start &&
    lhs.text[lhsEnd - 1] === rhs.text[rhsEnd - 1]
  ) {
    lhsEnd--;

    rhsEnd--;
  }

  if (lhsEnd > start) lhs.spans.push({ start, end: lhsEnd });

  if (rhsEnd > start) rhs.spans.push({ start, end: rhsEnd });
}

export function createWebDiffView(
  options: WebDiffViewOptions,
): ReviewDiffViewFactory {
  const create = (spec: ReviewDiffViewSpec): ReviewDiffViewHandle => {
    const document = spec.container.ownerDocument;

    const abort = new AbortController();

    const errorListeners = new Set<(message: string) => void>();

    let disposed = false;

    const root = document.createElement("div");

    root.className = "wb-diff";

    root.tabIndex = -1;

    const style = document.createElement("style");

    style.textContent = CSS;

    root.append(style);

    const fontSize = options.codeFontSize?.();

    if (fontSize !== undefined) root.style.fontSize = `${fontSize}px`;

    const status = document.createElement("div");

    status.className = "wb-diff-status";

    status.textContent = "Loading diff…";

    root.append(status);

    const list = document.createElement("div");

    root.append(list);

    spec.container.append(root);

    const sections = new Map<string, FileSection>();

    let progress: ReviewDiffProgress | undefined;

    let savedScroll: number | undefined;

    let revealRequested: { path: string } | undefined;

    let statusRemoved = false;

    root.addEventListener("scroll", () => {
      savedScroll = root.scrollTop;
    });

    const fail = (message: string) => {
      status.textContent = message;

      for (const listener of errorListeners) listener(message);
    };

    const removeStatus = () => {
      statusRemoved = true;

      status.remove();
    };

    const makeHalf = (
      side: "lhs" | "rhs",
      line: WebDiffLine | undefined,
      onFold: (id: number, collapsed: boolean) => void,
    ): HTMLElement => {
      const el = document.createElement("div");

      el.className = "wb-half";

      if (!line) {
        el.classList.add("gap");

        return el;
      }

      if (line.changed) el.classList.add(`changed-${side}`);

      const num = document.createElement("span");

      num.className = "wb-num";

      num.textContent = String(line.number);

      el.append(num);

      const fold = document.createElement("span");

      fold.className = "wb-fold";

      if (line.fold) {
        fold.textContent = line.fold.collapsed ? "▸" : "▾";
        fold.title =
          line.fold.label ?? (line.fold.collapsed ? "Expand" : "Collapse");

        fold.addEventListener("click", (event) => {
          event.stopPropagation();

          onFold(line.fold!.id, !line.fold!.collapsed);
        });
      }

      el.append(fold);

      const code = document.createElement("span");

      code.className = "wb-code";

      code.append(textWithSpans(document, line));

      el.append(code);

      return el;
    };

    interface EmitContext {
      fold(id: number, collapsed: boolean): void;

      expand(
        row: Extract<WebDiffRow, { type: "expand" }>,
        marker: HTMLElement,
      ): void;
    }

    const emitRow = (row: WebDiffRow, context: EmitContext): HTMLElement => {
      if (row.type === "expand") {
        if (row.hidden.length === 0) {
          // A hunk header or note: a label with nothing to expand.
          const note = document.createElement("div");

          note.className = "wb-expand static";

          note.textContent = row.label ?? "";

          return note;
        }

        const marker = document.createElement("button");

        marker.type = "button";

        marker.className = "wb-expand";

        const count = row.hidden.length;

        marker.textContent = `▸ ${row.label ?? `${count} line${count === 1 ? "" : "s"}`}`;

        marker.addEventListener("click", () => context.expand(row, marker));

        return marker;
      }

      if (row.lhs && row.rhs) pairSpans(row.lhs, row.rhs);

      const el = document.createElement("div");

      el.className = "wb-row";

      if (row.lhs) el.dataset.lhs = String(row.lhs.line);

      if (row.rhs) el.dataset.rhs = String(row.rhs.line);

      if (options.layout() === "split") {
        el.append(
          makeHalf("lhs", row.lhs, context.fold),
          makeHalf("rhs", row.rhs, context.fold),
        );
      } else {
        // Unified: a paired row shows the head line; a one-sided row shows
        // its side with its change background.
        el.classList.add("unified");

        el.append(
          makeHalf(row.rhs ? "rhs" : "lhs", row.rhs ?? row.lhs, context.fold),
        );
      }

      return el;
    };

    const renderRows = (section: FileSection, rows: WebDiffRow[]): void => {
      const table = document.createElement("div");

      table.className = "wb-table";
      table.style.gridTemplateColumns =
        options.layout() === "split" ? "1fr 1fr" : "1fr";

      const context: EmitContext = {
        fold: (id, collapsed) => {
          if (!section.folds) return;

          if (collapsed) section.folds.add(id);
          else section.folds.delete(id);

          rerender(section);
        },
        expand: (row, marker) => {
          if (row.foldId !== undefined && section.folds) {
            section.folds.delete(row.foldId);

            rerender(section);

            return;
          }

          // Plain context: splice the hidden lines in where the marker was.
          const fragment = document.createDocumentFragment();

          for (const pair of row.hidden)
            fragment.append(emitRow({ type: "line", ...pair }, context));

          marker.replaceWith(fragment);
        },
      };

      for (const row of rows) table.append(emitRow(row, context));

      section.body.replaceChildren(table);
    };

    const rerender = (section: FileSection): void => {
      if (section.error) {
        const el = document.createElement("div");

        el.className = "wb-file-error";

        el.textContent = section.error;

        section.body.replaceChildren(el);

        return;
      }

      const diff = section.diff;

      if (!diff) return;

      if (diff.type === "binary") {
        const el = document.createElement("div");

        el.className = "wb-file-note";

        el.textContent = `Binary file (${diff.lhs?.size ?? 0} → ${diff.rhs?.size ?? 0} bytes)`;

        section.body.replaceChildren(el);

        return;
      }

      const hidden = hiddenFileLabel(diff);

      if (hidden && !section.opened) {
        const el = document.createElement("button");

        el.type = "button";

        el.className = "wb-expand";

        el.textContent = `▸ ${hidden}`;

        el.addEventListener("click", () => {
          section.opened = true;

          rerender(section);
        });

        section.body.replaceChildren(el);

        return;
      }

      if (section.file)
        renderRows(
          section,
          buildWebDiffRows({
            diff,
            file: section.file,
            collapsed: section.folds ?? new Set(),
            lens: spec.lens,
          }).rows,
        );
    };

    const applyProgress = (section: FileSection): void => {
      const file = progress?.files.find((entry) => entry.path === section.path);

      if (section.viewed) {
        section.viewed.checked =
          file?.state === "viewed" || file?.state === "folded";

        section.viewed.indeterminate = file?.state === "partial";

        section.viewed.disabled = !file;
      }

      section.section.classList.toggle(
        "is-viewed",
        file?.state === "viewed" || file?.state === "folded",
      );

      // Ranges a viewed mark must keep open win over fold state.
      if (
        file?.unfoldRanges &&
        section.diff?.type === "text" &&
        section.folds
      ) {
        const regions: { id: number; start: number; end: number }[] = [];

        const walk = (region: StructuralRegion) => {
          regions.push({
            id: region.fold_state_id,
            start: region.start.line,
            end:
              region.end.column === 0 ? region.end.line : region.end.line + 1,
          });

          if (region.kind === "fold") region.children.forEach(walk);
        };

        for (const source of [section.diff.lhs, section.diff.rhs])
          if (source) walk(source.root);

        let changed = false;

        for (const range of file.unfoldRanges)
          for (const region of regions)
            if (
              section.folds.has(region.id) &&
              range.fromLine - 1 < region.end &&
              range.toLine > region.start
            ) {
              section.folds.delete(region.id);

              changed = true;
            }

        if (changed) rerender(section);
      }
    };

    const makeSection = (
      path: string,
      status: string,
      counts?: { add: number; del: number },
    ): FileSection => {
      const section = document.createElement("section");

      section.className = "wb-file";

      section.dataset.wbPath = path;

      const header = document.createElement("div");

      header.className = "wb-file-head";

      const caret = document.createElement("span");

      caret.className = "wb-file-caret";

      caret.textContent = "▾";

      const name = document.createElement("span");

      name.className = "wb-file-path";

      name.textContent = path;

      name.title = path;

      const statusEl = document.createElement("span");

      statusEl.className = "wb-file-status";

      statusEl.textContent = STATUS_LABELS.get(status) ?? status;

      const countsEl = document.createElement("span");

      countsEl.className = "wb-file-counts";

      if (counts) {
        const add = document.createElement("span");

        add.className = "add";

        add.textContent = `+${counts.add}`;

        const del = document.createElement("span");

        del.className = "del";

        del.textContent = ` −${counts.del}`;

        countsEl.append(add, del);
      }

      header.append(caret, name, statusEl, countsEl);

      let viewed: HTMLInputElement | undefined;

      if (spec.onToggleViewed) {
        viewed = document.createElement("input");

        viewed.type = "checkbox";

        viewed.className = "wb-file-viewed";

        viewed.title = "Mark file viewed";

        viewed.addEventListener("click", (event) => {
          event.stopPropagation();
          spec.onToggleViewed?.(path);
        });

        header.append(viewed);
      }

      const body = document.createElement("div");

      body.className = "wb-file-body";

      header.addEventListener("click", () => {
        const collapsed = !section.classList.contains("collapsed");

        section.classList.toggle("collapsed", collapsed);

        caret.textContent = collapsed ? "▸" : "▾";
      });

      section.append(header, body);

      list.append(section);

      const record: FileSection = {
        path,
        status,
        section,
        body,
        counts: countsEl,
        caret,
        viewed,
      };

      sections.set(path, record);

      applyProgress(record);

      return record;
    };

    const renderTree = (
      entries: {
        path: string;
        status: string;
        counts?: { add: number; del: number };
      }[],
    ) => {
      if (!spec.fileTreeContainer) return;

      const tree = spec.fileTreeContainer.ownerDocument.createElement("div");

      tree.className = "wb-tree";

      for (const entry of entries) {
        const button =
          spec.fileTreeContainer.ownerDocument.createElement("button");

        button.type = "button";

        const name = spec.fileTreeContainer.ownerDocument.createElement("span");

        name.textContent = entry.path;

        button.append(name);

        if (entry.counts) {
          const counts =
            spec.fileTreeContainer.ownerDocument.createElement("span");

          counts.className = "wb-file-counts";

          const add =
            spec.fileTreeContainer.ownerDocument.createElement("span");

          add.className = "add";

          add.textContent = `+${entry.counts.add}`;

          const del =
            spec.fileTreeContainer.ownerDocument.createElement("span");

          del.className = "del";

          del.textContent = ` −${entry.counts.del}`;

          counts.append(add, del);

          button.append(counts);
        }

        button.addEventListener("click", () => revealFile(entry.path));

        tree.append(button);
      }

      spec.fileTreeContainer.replaceChildren(tree);
    };

    const revealFile = (path: string, arg?: { restore?: boolean }) => {
      if (arg?.restore && savedScroll !== undefined) {
        root.scrollTop = savedScroll;

        return;
      }

      const section = sections.get(path);

      if (section) {
        section.section.classList.remove("collapsed");

        section.caret.textContent = "▾";

        section.section.scrollIntoView({ block: "start" });
      } else revealRequested = { path };
    };

    const streamStructural = async () => {
      try {
        const events = options.source.structural(
          {
            version: options.sourceVersion?.(),
            commit: spec.scope?.commit,
          },
          abort.signal,
        );

        for await (const event of events) {
          if (disposed) return;

          if (event.type === "start") {
            renderTree(
              event.files.map((change) => ({
                path: structuralFilePath(change.file),
                status: change.status,
              })),
            );

            for (const change of event.files) {
              const path = structuralFilePath(change.file);

              if (!sections.has(path)) makeSection(path, change.status);
            }

            removeStatus();

            continue;
          }

          if (event.type === "complete") {
            if (event.aborted && !statusRemoved)
              status.textContent = `diffr stopped early: ${event.aborted.message}`;

            continue;
          }

          if (event.type !== "file") continue;

          const path = structuralFilePath(event.file);

          const section = sections.get(path) ?? makeSection(path, "modified");

          section.file = event.file;

          if (event.error) {
            section.error = event.error.message;
          } else if (event.diff) {
            section.diff = event.diff;
            section.folds =
              event.diff.type === "text" ? seedFolds(event.diff) : undefined;

            if (event.diff.type === "text") {
              const counts = event.diff.stats.visible;

              const add = document.createElement("span");

              add.className = "add";

              add.textContent = `+${counts.added}`;

              const del = document.createElement("span");

              del.className = "del";

              del.textContent = ` −${counts.removed}`;

              section.counts.replaceChildren(add, del);
            } else {
              const note = document.createElement("span");

              note.textContent = "binary";

              section.counts.replaceChildren(note);
            }
          }

          applyProgress(section);

          rerender(section);

          if (revealRequested?.path === path) {
            revealRequested = undefined;

            revealFile(path);
          }
        }
      } catch (error) {
        if (!disposed && !abort.signal.aborted)
          fail(
            error instanceof Error
              ? error.message
              : "The structural diff could not be loaded.",
          );
      }
    };

    const loadTextual = async () => {
      try {
        const [summaries, patches] = await Promise.all([
          options.source.files(spec.scope, false),
          options.source.files(spec.scope, true),
        ]);

        if (disposed) return;

        removeStatus();

        renderTree(
          summaries.map((file) => ({
            path: file.path,
            status: file.status,
            counts: file.binary
              ? undefined
              : { add: file.additions, del: file.deletions },
          })),
        );

        for (const summary of summaries) {
          const section = makeSection(
            summary.path,
            summary.status,
            summary.binary
              ? undefined
              : { add: summary.additions, del: summary.deletions },
          );

          const patched = patches.find((file) => file.path === summary.path);

          if (summary.binary) {
            const el = document.createElement("div");

            el.className = "wb-file-note";

            el.textContent = "Binary file";

            section.body.replaceChildren(el);
          } else if (patched?.patch) {
            renderRows(section, patchRows(patched.patch));
          } else {
            const el = document.createElement("div");

            el.className = "wb-file-note";

            el.textContent = "No diff output for this file.";

            section.body.replaceChildren(el);
          }
        }

        if (revealRequested) {
          const { path } = revealRequested;

          revealRequested = undefined;

          revealFile(path);
        }
      } catch (error) {
        if (!disposed && !abort.signal.aborted)
          fail(
            error instanceof Error
              ? error.message
              : "The diff could not be loaded.",
          );
      }
    };

    const layoutSubscription = options.onDidChangeLayout(() => {
      for (const section of sections.values()) rerender(section);
    });

    let observer: ResizeObserver | undefined;

    if (spec.document) {
      observer = new ResizeObserver(() =>
        spec.document?.onDidChangeHeight(root.scrollHeight),
      );

      observer.observe(root);
    }

    if (options.structural()) void streamStructural();
    else void loadTextual();

    return {
      dispose() {
        disposed = true;

        abort.abort();
        observer?.disconnect();

        layoutSubscription.dispose();

        root.remove();
      },
      focus() {
        root.focus();
      },
      setProgress(next) {
        progress = next;

        for (const section of sections.values()) applyProgress(section);
      },
      revealFile,
      revealSource(source) {
        const section = sections.get(source.file);

        if (section?.diff?.type !== "text" || !section.folds) return;

        const line = source.fromLine - 1;

        const regions: StructuralRegion[] = [];

        const walk = (region: StructuralRegion) => {
          regions.push(region);

          if (region.kind === "fold") region.children.forEach(walk);
        };

        const side =
          source.side === "base" ? section.diff.lhs : section.diff.rhs;

        if (side) walk(side.root);

        for (const region of regions)
          if (
            section.folds.has(region.fold_state_id) &&
            line > region.start.line &&
            line <
              (region.end.column === 0 ? region.end.line : region.end.line + 1)
          )
            section.folds.delete(region.fold_state_id);

        rerender(section);

        const el = section.body.querySelector(
          `[data-${source.side === "base" ? "lhs" : "rhs"}="${line}"]`,
        );

        if (el) {
          el.scrollIntoView({ block: "center" });

          el.classList.add("wb-flash");
        }
      },
      onDidError(listener) {
        errorListeners.add(listener);

        return { dispose: () => errorListeners.delete(listener) };
      },
    };
  };

  return {
    create,
    files: (scope) => options.source.files(scope, false),
  };
}
