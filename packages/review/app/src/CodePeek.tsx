import type {
  ReviewDiffSide,
  ReviewInlineEditorHeightMode,
  ReviewInlineEditorRange,
} from "@dev.fast/review-protocol";
import {
  type DiffSelection,
  selectionKey,
  sourceAnchor,
  sourcePinsKey,
} from "@review/lens-selection";
import {
  type FileLineRange,
  SourceRangeError,
  codePeekSource,
  sliceSourceRange,
} from "@review/source";
import * as stylex from "@stylexjs/stylex";
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { z } from "zod";

import { useCodeCardExpanded } from "./code-card-state";
import {
  CodeExcerptCard,
  CodeFullViewerDialog,
  CodeFullViewerLines,
  SourceUnavailableCard,
} from "./code-excerpt-card";
import { languageFromFilename } from "./code-highlighting";
import {
  type LineRange,
  expandRangesWithContext,
  formatLineRangeLabel,
  lineRangeGaps,
  mergeLineRanges,
} from "./code-line-ranges";
import { DocumentCodeView } from "./DocumentCodeView";
import { drawStyles } from "./draw-styles";
import { useReviewSession } from "./host/review-session";
import { codeInspectorMarker, documentMarker } from "./markers.stylex";
import {
  type PeekResolutionOutcome,
  peekResolutionOutcome,
} from "./peek-telemetry";
import { type ReviewLensView, useReviewLenses } from "./review-lenses";
import type { SourcePeekAnchor } from "./review-panel-model";
import { withClass } from "./stylex-props";
import { tokens } from "./tokens.stylex";
import { captureUiEvent } from "./ui-telemetry";
import { Button } from "./ui/button";

/** +-5 lines, the amount "Show surrounding context" reveals on each side of
 * a selection, bounded by the file and merged across overlapping windows. */
const CONTEXT_LINES = 5;

/** The software-map inspector's peek input: a range on one diff side. */
export interface CodePeekProps {
  file: string;
  fromLine: number;
  toLine: number;
  graph?: "head" | "base";
  lenses?: ReviewLensView;
}

export interface CodePeekSubject {
  title: string;
  file: string;
  line: number;
  endLine: number;
}

// Internal interactive surface used by the software-map inspector. Authored
// Review documents receive ReviewCodePeek instead.
export function CodePeek(props: CodePeekProps) {
  const source = useMemo(() => codePeekSource(props), [props]);
  const session = useReviewSession();

  if (session.config.surface === "web")
    return (
      <WebCodePeek
        file={source.file}
        pins={source.pins}
        ranges={[
          {
            side: source.side,
            startLine: source.fromLine,
            endLine: source.toLine,
          },
        ]}
        outcome="resolved"
      />
    );

  return (
    <FileSnippetCard
      source={source}
      heightMode="content"
      lenses={props.lenses}
    />
  );
}

interface GroupedCodePeek {
  key: string;
  file: string;
  side: ReviewDiffSide;
  ranges: ReviewInlineEditorRange[];
  countRanges?: ReviewInlineEditorRange[];
}

interface AuthoredCodePeekRange extends ReviewInlineEditorRange {
  side: ReviewDiffSide;
}

export function CodePeekGroup({
  peeks,
  collapsed = false,
  lenses,
}: {
  peeks: readonly FileLineRange[];
  collapsed?: boolean;
  lenses?: ReviewLensView;
}) {
  const session = useReviewSession();

  const groups = useMemo(() => groupedCodePeeks(peeks), [peeks]);

  return (
    <>
      {groups.map((group) => {
        const primaryRange = group.ranges[0]!;

        if (session.config.surface === "web")
          return (
            <WebCodePeek
              key={group.key}
              file={group.file}
              ranges={group.ranges.map((range) => ({
                ...range,
                side: range.side ?? group.side,
              }))}
              outcome="resolved"
            />
          );

        return (
          <NativeCodePeekSection
            key={group.key}
            contextStateKey={`group:${group.key}:${(
              group.countRanges ?? group.ranges
            )
              .map(
                (range) =>
                  `${range.side ?? group.side}:${range.startLine}-${range.endLine}`,
              )
              .sort()
              .join(",")}`}
            defaultSide={group.side}
            baseRanges={group.ranges}
            label={`${group.file}, full snippet`}
          >
            {(displayRanges, variant) => (
              <DocumentCodeView
                path={group.file}
                title={group.file}
                side={group.side}
                ranges={displayRanges}
                heightMode="content"
                countRanges={group.countRanges}
                active={variant === "full"}
                collapsed={variant === "inline" && collapsed}
                lenses={lenses}
                onOpen={
                  variant === "inline"
                    ? () =>
                        session.surface.revealAnchor(
                          group.file,
                          {
                            fromLine: primaryRange.startLine,
                            toLine: primaryRange.endLine,
                          },
                          primaryRange.side ?? group.side,
                        )
                    : undefined
                }
              />
            )}
          </NativeCodePeekSection>
        );
      })}
    </>
  );
}

export function ReviewCodePeek({ anchor }: { anchor: SourcePeekAnchor }) {
  return <CodePeekCard source={anchor.peek} />;
}

/** A document peek is an interval of the same alignment used by diff lenses. */
export function CodePeekCard({
  source,
  active = false,
  heightMode = "capped",
  onNativeFocus,
  lenses: lensesOverride,
  reportOutcome = false,
  stateScope,
}: {
  source: DiffSelection;
  active?: boolean;
  heightMode?: ReviewInlineEditorHeightMode;
  onNativeFocus?: () => void;
  lenses?: ReviewLensView;
  /** Report resolution telemetry. Only the panel the user opened sets this,
   * so an authored document with many inline peeks sends one event, not N. */
  reportOutcome?: boolean;
  /** Keeps expansion and scroll state to one step or code item, so two
   * steps citing the same lines never share it. */
  stateScope?: string;
}) {
  const session = useReviewSession();
  const contextLenses = useReviewLenses();
  const lenses = lensesOverride ?? contextLenses;
  const anchor = sourceAnchor(source);

  const ranges = useMemo(
    () =>
      (lenses?.resolve([source]) ?? []).map((range) => ({
        side: range.side,
        startLine: range.fromLine,
        endLine: range.toLine,
      })),
    [lenses, source],
  );

  const key = selectionKey(source);

  const outcome = peekResolutionOutcome({
    resolvedCount: ranges.length,
    complete: Boolean(lenses?.progress?.complete),
    unavailable: Boolean(lenses?.progress?.unavailableSelections?.[key]),
    error: Boolean(lenses?.error),
  });

  const reportedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!reportOutcome || outcome === "pending" || reportedKey.current === key)
      return;
    reportedKey.current = key;
    captureUiEvent(
      session,
      outcome === "resolved" ? "peek_resolved" : "peek_resolve_failed",
      { root_kind: "range" },
    );
  }, [key, outcome, reportOutcome, session]);

  const scope = stateScope ? `${stateScope}:` : "";

  // A selection that never resolved has no lines to excerpt: say which
  // source was asked for instead of guessing one.
  if (!ranges.length && outcome !== "pending")
    return (
      <section {...withClass("code-peek", styles.peek, drawStyles.blockChild)}>
        <SourceUnavailableCard
          file={anchor.file}
          side={anchor.side}
          revision={sourceRevision(anchor.side, source.pins)}
          rangeLabel={formatLineRangeLabel([
            { startLine: anchor.fromLine, endLine: anchor.toLine },
          ])}
          reason="The requested range could not be resolved at this revision."
        />
      </section>
    );

  if (session.config.surface === "web")
    return (
      <WebCodePeek
        file={source.file}
        pins={source.pins}
        ranges={ranges}
        outcome={outcome}
        stateScope={stateScope}
      />
    );

  if (!ranges.length)
    return (
      <section
        {...withClass("code-peek", styles.peek, drawStyles.blockChild)}
        role="status"
      >
        Loading diff selection…
      </section>
    );

  return (
    <section
      {...withClass("code-peek", styles.peek, drawStyles.blockChild)}
      data-code-rendering="inline-editor"
    >
      <NativeCodePeekSection
        contextStateKey={`${scope}card:${key}`}
        defaultSide={anchor.side}
        baseRanges={ranges}
        label={`${source.file}, full snippet`}
      >
        {(displayRanges, variant) => (
          <DocumentCodeView
            path={source.file}
            title={
              source.start.side === source.end.side
                ? codePeekRangeTitle(
                    source.file,
                    source.start.line,
                    source.end.line,
                  )
                : source.file
            }
            side={anchor.side}
            pins={source.pins}
            ranges={displayRanges}
            countRanges={ranges}
            heightMode={variant === "full" ? "content" : heightMode}
            active={variant === "full" ? true : active}
            onFocus={variant === "inline" ? onNativeFocus : undefined}
            onOpen={
              variant === "inline"
                ? () =>
                    session.surface.revealAnchor(
                      anchor.file,
                      { fromLine: anchor.fromLine, toLine: anchor.toLine },
                      anchor.side,
                      source.pins,
                    )
                : undefined
            }
          />
        )}
      </NativeCodePeekSection>
    </section>
  );
}

/** Native "Show surrounding context": widens `baseRanges` by +-5 lines per
 * side, merged, lower-bounded at line 1 (the native editor's own model
 * clamps a request past its last line, so no upper bound is needed here).
 * `countRanges` passed to the editor stays the unwidened selection, so it
 * keeps marking which lines are authored versus revealed context. */
function NativeCodePeekSection({
  contextStateKey,
  defaultSide,
  baseRanges,
  label,
  children,
}: {
  contextStateKey: string;
  defaultSide: ReviewDiffSide;
  baseRanges: readonly ReviewInlineEditorRange[];
  /** The full-snippet dialog's accessible name, e.g. "src/app.ts, full
   * snippet". */
  label: string;
  /** `variant` is "full" only for the uncapped copy rendered inside the
   * larger viewer dialog, with the unwidened selection and no surrounding
   * chrome (no focus/open callbacks): a read-only inspector, not a second
   * interactive surface. */
  children: (
    ranges: ReviewInlineEditorRange[],
    variant: "inline" | "full",
  ) => ReactNode;
}) {
  const [showContext, setShowContext] = useCodeCardExpanded(
    contextStateKey,
    false,
  );

  const [fullOpen, setFullOpen] = useState(false);
  const regionId = useId();
  const openFullRef = useRef<HTMLButtonElement | null>(null);

  const displayRanges = showContext
    ? expandMixedSideRanges(baseRanges, defaultSide, CONTEXT_LINES)
    : [...baseRanges];

  return (
    <>
      <div id={regionId}>{children(displayRanges, "inline")}</div>
      <div {...withClass("code-peek-context-toggle", styles.contextToggle)}>
        <Button
          variant="ghost"
          aria-expanded={showContext}
          aria-controls={regionId}
          onClick={() => setShowContext(!showContext)}
        >
          {showContext
            ? "Hide surrounding context"
            : "Show surrounding context"}
        </Button>
        <Button
          ref={openFullRef}
          variant="ghost"
          onClick={() => setFullOpen(true)}
        >
          Open full snippet
        </Button>
      </div>
      <CodeFullViewerDialog
        open={fullOpen}
        onClose={() => setFullOpen(false)}
        triggerRef={openFullRef}
        label={label}
      >
        {children([...baseRanges], "full")}
      </CodeFullViewerDialog>
    </>
  );
}

function expandMixedSideRanges(
  ranges: readonly ReviewInlineEditorRange[],
  defaultSide: ReviewDiffSide,
  context: number,
): ReviewInlineEditorRange[] {
  const sides: readonly ReviewDiffSide[] =
    defaultSide === "head" ? ["head", "base"] : ["base", "head"];

  const expanded: ReviewInlineEditorRange[] = [];

  for (const side of sides) {
    const sideRanges: LineRange[] = ranges.flatMap((range) =>
      (range.side ?? defaultSide) === side
        ? [{ startLine: range.startLine, endLine: range.endLine }]
        : [],
    );

    if (!sideRanges.length) continue;

    for (const range of expandRangesWithContext(sideRanges, context, {
      minLine: 1,
    })) {
      const compact: ReviewInlineEditorRange = {
        startLine: range.startLine,
        endLine: range.endLine,
      };

      if (side !== defaultSide) compact.side = side;
      expanded.push(compact);
    }
  }

  return expanded;
}

interface WebSourceFileState {
  text?: string;
  error?: string;
}

function WebCodePeek({
  file,
  pins,
  ranges,
  outcome,
  stateScope,
}: {
  file: string;
  pins?: DiffSelection["pins"];
  ranges: readonly {
    side: ReviewDiffSide;
    startLine: number;
    endLine: number;
  }[];
  outcome: PeekResolutionOutcome;
  stateScope?: string;
}) {
  const session = useReviewSession();

  const sides = useMemo(
    () => [...new Set(ranges.map((range) => range.side))].sort(),
    [ranges],
  );

  const sidesKey = sides.join(",");
  const pinsKey = pins ? sourcePinsKey(pins) : "";

  const [filesBySide, setFilesBySide] = useState<
    Record<string, WebSourceFileState>
  >({});

  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = (requestIdRef.current += 1);
    const controller = new AbortController();

    setFilesBySide({});

    void Promise.all(
      sides.map(
        async (side): Promise<readonly [string, WebSourceFileState]> => {
          const query = new URLSearchParams({ side, file });

          if (pins) {
            query.set("repositoryId", pins.repositoryId);
            query.set("head", pins.head);

            if (pins.base) query.set("base", pins.base);
          }

          try {
            const response = await session.fetch(`/file?${query.toString()}`, {
              signal: controller.signal,
            });

            if (!response.ok) throw new Error("Source unavailable");

            const { text } = z
              .object({ text: z.string() })
              .parse(await response.json());

            return [side, { text }];
          } catch (caught) {
            return [
              side,
              {
                error:
                  caught instanceof DOMException && caught.name === "AbortError"
                    ? undefined
                    : "This code peek is not available in web reviews.",
              },
            ];
          }
        },
      ),
    ).then((entries) => {
      if (requestIdRef.current !== requestId) return; // a newer request superseded this one
      setFilesBySide(Object.fromEntries(entries));
    });

    return () => controller.abort();
    // eslint-disable-next-line -- `sides`/`pins` are compared through their derived string keys below.
  }, [session, file, sidesKey, pinsKey]);

  if (!ranges.length)
    return (
      <section
        className="code-peek"
        role={outcome === "pending" ? "status" : "note"}
      >
        {outcome === "pending"
          ? "Loading code peek…"
          : "This code peek is not available in web reviews."}
      </section>
    );

  return (
    <section
      {...withClass("code-peek", styles.peek, drawStyles.blockChild)}
      data-code-rendering="read-only"
    >
      {sides.map((side) => (
        <WebSourceExcerpt
          key={side}
          file={file}
          side={side}
          pins={pins}
          ranges={ranges.filter((range) => range.side === side)}
          state={filesBySide[side]}
          stateScope={stateScope}
        />
      ))}
    </section>
  );
}

/** One side's compact excerpt card: the file text is already loaded (one
 * fetch per side, shared across every disjoint range on it); everything
 * else — context, the full viewers, copy — works on that loaded text, with
 * no further request. */
function WebSourceExcerpt({
  file,
  side,
  pins,
  ranges,
  state,
  stateScope,
}: {
  file: string;
  side: ReviewDiffSide;
  pins?: DiffSelection["pins"];
  ranges: readonly { startLine: number; endLine: number }[];
  state: WebSourceFileState | undefined;
  stateScope?: string;
}) {
  const relevantRanges = useMemo(() => mergeLineRanges(ranges), [ranges]);
  const rangeLabel = formatLineRangeLabel(relevantRanges);
  const regionId = useId();
  const revision = sourceRevision(side, pins);

  const stateKey = `${stateScope ? `${stateScope}:` : ""}${file}:${side}:${pins ? sourcePinsKey(pins) : ""}:${relevantRanges
    .map((range) => `${range.startLine}-${range.endLine}`)
    .join(",")}`;

  const [showContext, setShowContext] = useCodeCardExpanded(
    `web-context:${stateKey}`,
    false,
  );

  const [dialog, setDialog] = useState<"snippet" | "file" | null>(null);
  const openSnippetRef = useRef<HTMLButtonElement | null>(null);
  const openFileRef = useRef<HTMLButtonElement | null>(null);

  const language = languageFromFilename(file);

  const identity = `${side === "base" ? "Base" : "Head"} · ${
    revision ?? "review revision"
  }`;

  if (!state)
    return (
      <p role="status" {...stylex.props(styles.webLoading)}>
        Loading code peek…
      </p>
    );

  if (state.error !== undefined || state.text === undefined)
    return (
      <SourceUnavailableCard
        file={file}
        side={side}
        revision={revision}
        rangeLabel={rangeLabel}
        reason={state.error}
      />
    );

  const text = state.text;

  const lines = text.endsWith("\n")
    ? text.slice(0, -1).split("\n")
    : text.split("\n");

  const displayRanges = showContext
    ? expandRangesWithContext(relevantRanges, CONTEXT_LINES, {
        minLine: 1,
        maxLine: lines.length,
      })
    : relevantRanges;

  const slice = (range: LineRange) =>
    sliceSourceRange(text, {
      file,
      fromLine: range.startLine,
      toLine: range.endLine,
    });

  let selectedChunks: string[];
  let segments: { startLine: number; code: string }[];

  try {
    // The authored selection is validated as-is, before any context widens
    // it: clamped context must never make an out-of-bounds range look valid.
    selectedChunks = relevantRanges.map(slice);
    segments = displayRanges.map((range) => ({
      startLine: range.startLine,
      code: slice(range),
    }));
  } catch (caught) {
    return (
      <SourceUnavailableCard
        file={file}
        side={side}
        revision={revision}
        rangeLabel={rangeLabel}
        reason={
          caught instanceof SourceRangeError
            ? caught.message
            : "Source unavailable."
        }
      />
    );
  }

  const gaps = lineRangeGaps(displayRanges);

  const copyText = segments.map((segment) => segment.code).join("\n");

  const fullSnippetText = selectedChunks.join("\n");

  return (
    <>
      <CodeExcerptCard
        title={file}
        language={language}
        rangeLabel={`${side === "base" ? "base " : ""}${rangeLabel}`}
        segments={segments}
        gaps={gaps}
        relevantRanges={showContext ? relevantRanges : undefined}
        copyText={copyText}
        ariaLabel={`${file}, ${side} lines ${rangeLabel}`}
        scrollKey={stateKey}
        bodyId={regionId}
        footer={
          <>
            <Button
              variant="ghost"
              aria-expanded={showContext}
              aria-controls={regionId}
              onClick={() => setShowContext(!showContext)}
            >
              {showContext
                ? "Hide surrounding context"
                : "Show surrounding context"}
            </Button>
            <Button
              ref={openSnippetRef}
              variant="ghost"
              onClick={() => setDialog("snippet")}
            >
              Open full snippet
            </Button>
            <Button
              ref={openFileRef}
              variant="ghost"
              onClick={() => setDialog("file")}
            >
              Open full file
            </Button>
          </>
        }
      />
      <CodeFullViewerDialog
        open={dialog === "snippet"}
        onClose={() => setDialog(null)}
        triggerRef={openSnippetRef}
        label={`${file}, full snippet`}
        identity={identity}
        copyLabel="Copy full snippet"
        copyText={fullSnippetText}
      >
        {relevantRanges.map((range, index) => (
          <CodeFullViewerLines
            key={`${range.startLine}-${range.endLine}`}
            startLine={range.startLine}
            code={selectedChunks[index]!}
            language={language}
          />
        ))}
      </CodeFullViewerDialog>
      <CodeFullViewerDialog
        open={dialog === "file"}
        onClose={() => setDialog(null)}
        triggerRef={openFileRef}
        label={`${file}, full file`}
        identity={identity}
        copyLabel="Copy full file"
        copyText={text}
      >
        <CodeFullViewerLines startLine={1} code={text} language={language} />
      </CodeFullViewerDialog>
    </>
  );
}

function FileSnippetCard({
  source,
  active = false,
  heightMode = "capped",
  onNativeFocus,
  lenses,
}: {
  source: FileLineRange;
  active?: boolean;
  heightMode?: ReviewInlineEditorHeightMode;
  onNativeFocus?: () => void;
  lenses?: ReviewLensView;
}) {
  const session = useReviewSession();

  const subject = useMemo(() => codePeekSubject(source), [source]);

  const onNativeFocusRef = useRef(onNativeFocus);

  useEffect(() => {
    onNativeFocusRef.current = onNativeFocus;
  }, [onNativeFocus]);

  const contextStateKey = `snippet:${source.file}:${source.side}:${source.fromLine}-${source.toLine}:${
    source.pins ? sourcePinsKey(source.pins) : ""
  }`;

  return (
    <section
      {...withClass("code-peek", styles.peek, drawStyles.blockChild)}
      data-code-rendering="inline-editor"
    >
      <NativeCodePeekSection
        contextStateKey={contextStateKey}
        defaultSide={source.side}
        baseRanges={[{ startLine: subject.line, endLine: subject.endLine }]}
        label={`${subject.file}, full snippet`}
      >
        {(displayRanges, variant) => (
          <DocumentCodeView
            path={subject.file}
            title={subject.title}
            side={source.side}
            pins={source.pins}
            ranges={displayRanges}
            countRanges={[
              { startLine: subject.line, endLine: subject.endLine },
            ]}
            heightMode={variant === "full" ? "content" : heightMode}
            active={variant === "full" ? true : active}
            lenses={lenses}
            onFocus={
              variant === "inline"
                ? () => onNativeFocusRef.current?.()
                : undefined
            }
            onOpen={
              variant === "inline"
                ? () =>
                    session.surface.revealAnchor(
                      subject.file,
                      { fromLine: subject.line, toLine: subject.endLine },
                      source.side,
                      source.pins,
                    )
                : undefined
            }
          />
        )}
      </NativeCodePeekSection>
    </section>
  );
}

/** The effective revision one side of a pinned source reads from: base for
 * the base side (head alone means head against itself), head otherwise.
 * Unpinned sources read the review's own snapshot. */
function sourceRevision(
  side: ReviewDiffSide,
  pins: DiffSelection["pins"],
): string | undefined {
  if (!pins) return undefined;

  return `${pins.repositoryId}@${
    side === "base" ? (pins.base ?? pins.head) : pins.head
  }`;
}

export function codePeekSubject(source: FileLineRange): CodePeekSubject {
  return {
    title: codePeekRangeTitle(source.file, source.fromLine, source.toLine),
    file: source.file,
    line: source.fromLine,
    endLine: source.toLine,
  };
}

// The card header prints one label, and it elides from the left. So give it the
// whole path. A narrow card then keeps the deepest folders and the file name.
function codePeekRangeTitle(
  file: string,
  fromLine: number,
  toLine: number,
): string {
  const range = fromLine === toLine ? `${fromLine}` : `${fromLine}-${toLine}`;

  return `${file}:${range}`;
}

function groupedCodePeeks(peeks: readonly FileLineRange[]): GroupedCodePeek[] {
  const groups = new Map<
    string,
    Omit<GroupedCodePeek, "ranges"> & {
      ranges: AuthoredCodePeekRange[];
    }
  >();

  for (const peek of peeks) {
    const key = peek.file;
    let group = groups.get(key);

    if (!group) {
      group = {
        key,
        file: peek.file,
        side: peek.side,
        ranges: [],
      };
      groups.set(key, group);
    } else if (peek.side === "head") {
      group.side = "head";
    }

    group.ranges.push({
      startLine: peek.fromLine,
      endLine: peek.toLine,
      side: peek.side,
    });
  }

  return [...groups.values()].map((group) => ({
    ...group,
    countRanges: group.ranges,
    ranges: mergedCodePeekRanges(group.ranges, group.side),
  }));
}

function mergedCodePeekRanges(
  ranges: readonly AuthoredCodePeekRange[],
  defaultSide: ReviewDiffSide,
): ReviewInlineEditorRange[] {
  const merged: ReviewInlineEditorRange[] = [];

  const sides: readonly ReviewDiffSide[] =
    defaultSide === "head" ? ["head", "base"] : ["base", "head"];

  for (const side of sides) {
    const sideRanges = ranges
      .filter((range) => range.side === side)
      .sort((left, right) => left.startLine - right.startLine);

    const mergedForSide: AuthoredCodePeekRange[] = [];

    for (const range of sideRanges) {
      const previous = mergedForSide.at(-1);

      if (!previous || range.startLine > previous.endLine + 1) {
        mergedForSide.push({ ...range });
      } else {
        previous.endLine = Math.max(previous.endLine, range.endLine);
      }
    }

    for (const range of mergedForSide) {
      const compactRange: ReviewInlineEditorRange = {
        startLine: range.startLine,
        endLine: range.endLine,
      };

      if (side !== defaultSide) compactRange.side = side;
      merged.push(compactRange);
    }
  }

  return merged;
}

const narrow = "@media (max-width: 720px)";

const inDocument = () => stylex.when.ancestor(":is(*)", documentMarker);

// A block in a Review document shares the prose column.
const inDocumentBlock = () => `${inDocument()}:is([data-review-node-id] > *)`;

const inMapInspector = () =>
  stylex.when.ancestor(":is(*)", codeInspectorMarker);

// Peeks keep the `code-peek` class: document-embed-scroll.ts finds embeds by it.
const styles = stylex.create({
  peek: {
    width: {
      default: null,
      [inDocumentBlock()]: `min(100%, ${tokens.reviewBlockMaxWidth})`,
    },
    minWidth: 0,
    maxWidth: {
      default: "100%",
      [inDocumentBlock()]: `calc(100cqi - 2 * ${tokens.reviewDocumentPaddingInline})`,
    },
    marginInline: { default: null, [inDocumentBlock()]: "auto" },
    marginBlock: { default: "24px", [inMapInspector()]: 0 },
    overflow: { default: null, [inMapInspector()]: "visible" },
    padding: {
      default: null,
      [inMapInspector()]: { default: 0, [narrow]: "0 8px 8px" },
    },
    overscrollBehavior: {
      default: null,
      [inMapInspector()]: { default: null, [narrow]: "contain" },
    },
    color: tokens.ink,
    fontFamily: tokens.fontMono,
  },
  contextToggle: {
    display: "flex",
    marginTop: "4px",
  },
  webLoading: {
    padding: "8px 0",
    color: tokens.inkFaint,
  },
});
