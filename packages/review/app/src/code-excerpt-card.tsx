import { fontSize, fontWeight, layer, radius } from "@canvas/scale.stylex";
import * as stylex from "@stylexjs/stylex";
import {
  type ReactElement,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useId,
  useRef,
} from "react";
import { createPortal } from "react-dom";

import { ActionMenu, type ActionMenuItem } from "./action-menu";
import { usePersistedCodeScroll } from "./code-card-state";
import { CodeFontSizeContext } from "./code-font-size";
import {
  type ShjLanguage,
  normalizeMarkdownCodeLanguage,
  renderHighlightedLine,
  splitHighlightedTokensByLine,
  useHighlightedTokens,
} from "./code-highlighting";
import type { LineRange, LineRangeGap } from "./code-line-ranges";
import { isLineWithinRanges } from "./code-line-ranges";
import { CopyButton } from "./copy-text";
import { DiagramHeader } from "./diagram-header";
import { drawStyles } from "./draw-styles";
import { CloseIcon, DisclosureChevron } from "./icons";
import { useReviewContainer } from "./review-root-context";
import { withClass } from "./stylex-props";
import { tokens } from "./tokens.stylex";
import { Button } from "./ui/button";
import { surfaceStyles } from "./ui/surface";
import { useCanvasScrollLock } from "./use-canvas-scroll-lock";

export const DEFAULT_EXCERPT_HEIGHT_CAP_PX = 240;

export interface CodeExcerptCardSegment {
  /** Original 1-based line number of the segment's first line. */
  startLine: number;
  code: string;
}

export interface CodeExcerptCardProps {
  /** Filename when available; omitted entirely for a standalone snippet
   * without a source association. */
  title?: string;
  language?: string | null;
  /** The header's displayed range or line count, e.g. "12-34" or "5 lines". */
  rangeLabel: string;
  segments: readonly CodeExcerptCardSegment[];
  /** A hidden-lines divider rendered after `segments[gap.afterIndex]`. */
  gaps?: readonly LineRangeGap[];
  /** Lines left out after the last segment — a bounded preview's tail. */
  omittedAfter?: number;
  /** When set, a segment line outside these absolute line numbers renders
   * as dimmed, revealed context rather than the authored selection. */
  relevantRanges?: readonly LineRange[];
  copyLabel?: string;
  copyText: string;
  /** Inline height cap in px; omit or pass 0 to render uncapped (the full
   * viewer dialog). */
  heightCapPx?: number;
  /** The one visible disclosure control under the code; secondary commands
   * belong in `actions`. */
  toggle?: {
    expanded: boolean;
    collapsedLabel: string;
    expandedLabel: string;
    onToggle(): void;
  };
  /** Secondary commands, behind the header's "more" menu. */
  actions?: readonly ActionMenuItem[];
  /** The menu's trigger, for a dialog it opens to return focus to. */
  actionsTriggerRef?: RefObject<HTMLButtonElement | null>;
  ariaLabel: string;
  scrollKey?: string;
  /** The code region's id, for an expansion control's `aria-controls`. */
  bodyId?: string;
  className?: string;
}

/** The shared compact code card: a header (filename, language, range, Copy
 * excerpt) over highlighted, line-numbered code capped at a fixed height. */
export function CodeExcerptCard({
  title,
  language,
  rangeLabel,
  segments,
  gaps = [],
  omittedAfter = 0,
  relevantRanges,
  copyLabel = "Copy excerpt",
  copyText,
  heightCapPx = DEFAULT_EXCERPT_HEIGHT_CAP_PX,
  toggle,
  actions,
  actionsTriggerRef,
  ariaLabel,
  scrollKey,
  bodyId,
  className,
}: CodeExcerptCardProps): ReactElement {
  const normalizedLanguage = normalizeMarkdownCodeLanguage(language ?? "");
  const codeFontSize = useContext(CodeFontSizeContext);
  const bodyRef = useRef<HTMLPreElement | null>(null);

  usePersistedCodeScroll(scrollKey, bodyRef);

  const hasLines = segments.some((segment) => segment.code !== "");

  return (
    <figure
      {...withClass(className, styles.card, drawStyles.blockChild)}
      aria-label={ariaLabel}
      data-language={normalizedLanguage ?? undefined}
    >
      <DiagramHeader
        kind={normalizedLanguage ?? language?.trim() ?? "code"}
        title={title}
        meta={rangeLabel}
        xstyle={styles.header}
        metaStyle={styles.meta}
        action={
          <div {...stylex.props(styles.actions)}>
            <CopyButton
              text={copyText}
              label={copyLabel}
              xstyle={styles.copy}
              iconStyle={styles.copyIcon}
            />
            {actions && actions.length > 0 && (
              <ActionMenu
                label="More actions"
                items={actions}
                triggerRef={actionsTriggerRef}
                xstyle={styles.copy}
                iconStyle={styles.copyIcon}
              />
            )}
          </div>
        }
      />
      <pre
        ref={bodyRef}
        id={bodyId}
        {...stylex.props(styles.body)}
        style={{
          ...(heightCapPx ? { maxHeight: heightCapPx } : undefined),
          ...(codeFontSize === undefined
            ? undefined
            : { fontSize: codeFontSize }),
        }}
      >
        {segments.map((segment, index) => (
          <CodeExcerptSegmentLines
            key={`${segment.startLine}:${index}`}
            segment={segment}
            normalizedLanguage={normalizedLanguage}
            relevantRanges={relevantRanges}
            gapAfter={gaps.find((gap) => gap.afterIndex === index)}
          />
        ))}
        {omittedAfter > 0 && (
          <OmissionMarker
            text={`${omittedAfter} more ${omittedAfter === 1 ? "line" : "lines"} hidden`}
          />
        )}
      </pre>
      {!hasLines && (
        <p {...stylex.props(styles.empty)} role="status">
          No lines to show.
        </p>
      )}
      {toggle && (
        <Button
          variant="ghost"
          xstyle={styles.toggle}
          aria-expanded={toggle.expanded}
          aria-controls={bodyId}
          onClick={toggle.onToggle}
        >
          <DisclosureChevron expanded={toggle.expanded} />
          {toggle.expanded ? toggle.expandedLabel : toggle.collapsedLabel}
        </Button>
      )}
    </figure>
  );
}

function CodeExcerptSegmentLines({
  segment,
  normalizedLanguage,
  relevantRanges,
  gapAfter,
}: {
  segment: CodeExcerptCardSegment;
  normalizedLanguage: ShjLanguage | null;
  relevantRanges: readonly LineRange[] | undefined;
  gapAfter: LineRangeGap | undefined;
}): ReactElement {
  const lines = segment.code.split("\n");

  const highlightedTokens = useHighlightedTokens(
    segment.code,
    normalizedLanguage,
  );

  const tokenLines =
    normalizedLanguage && highlightedTokens
      ? splitHighlightedTokensByLine(highlightedTokens)
      : null;

  return (
    <>
      {lines.map((text, index) => {
        const lineNumber = segment.startLine + index;

        const dimmed =
          relevantRanges !== undefined &&
          !isLineWithinRanges(lineNumber, relevantRanges);

        return (
          <div
            key={lineNumber}
            {...stylex.props(styles.line, dimmed && styles.lineContext)}
          >
            <span aria-hidden="true" {...stylex.props(styles.gutter)}>
              {lineNumber}
            </span>
            <code data-review-copy-prose>
              {renderHighlightedLine(tokenLines?.[index], text)}
            </code>
          </div>
        );
      })}
      {gapAfter && (
        <OmissionMarker
          text={`${gapAfter.endLine - gapAfter.startLine + 1} ${
            gapAfter.endLine === gapAfter.startLine ? "line" : "lines"
          } hidden`}
        />
      )}
    </>
  );
}

/** "⋯ N lines hidden": read once by a screen reader, never selected or
 * copied along with the code around it. */
function OmissionMarker({ text }: { text: string }): ReactElement {
  return (
    <div {...stylex.props(styles.omission)} data-code-omission>
      <span aria-hidden="true">⋯ </span>
      {text}
    </div>
  );
}

export interface CodeFullViewerDialogProps {
  open: boolean;
  onClose: () => void;
  /** The trigger that opened the dialog; focus returns here on close. */
  triggerRef: RefObject<HTMLElement | null>;
  /** The dialog's accessible name, e.g. "src/app.ts, full file". */
  label: string;
  identity?: string;
  /** Omitted on surfaces where the body owns copy itself (the native
   * embedded editor supports its own Copy); shown whenever both are set. */
  copyLabel?: string;
  copyText?: string;
  children: ReactNode;
}

/** The larger, read-only viewer for "Open full snippet" / "Open full file":
 * a named, focus-managed, Escape-to-close dialog that fits the viewport. */
export function CodeFullViewerDialog({
  open,
  onClose,
  triggerRef,
  label,
  identity,
  copyLabel,
  copyText,
  children,
}: CodeFullViewerDialogProps): ReactElement | null {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const contextPortalTarget = useReviewContainer();

  const portalTarget =
    contextPortalTarget ??
    (typeof document === "undefined" ? null : document.body);

  useCanvasScrollLock(open);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    dialogRef.current?.focus({ preventScroll: true });

    // Capture on window runs before the side panel's own Escape listener on
    // document, so closing the viewer never also closes the walkthrough.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      } else if (event.key === "Tab") {
        trapTab(event, dialogRef.current);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      // The trigger sits in the step feed; focusing it must not scroll the
      // panel away from where the reader left it.
      triggerRef.current?.focus({ preventScroll: true });
    };
  }, [open, triggerRef]);

  if (!open || !portalTarget) return null;

  return createPortal(
    <div
      {...stylex.props(styles.backdrop)}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        {...stylex.props(surfaceStyles.dialog, styles.dialog)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header {...stylex.props(styles.dialogHeader)}>
          <div {...stylex.props(styles.dialogHeading)}>
            <h2 id={titleId} {...stylex.props(styles.dialogTitle)}>
              {label}
            </h2>
            {identity && (
              <p {...stylex.props(styles.dialogIdentity)}>{identity}</p>
            )}
          </div>
          <div {...stylex.props(styles.dialogActions)}>
            {copyLabel !== undefined && copyText !== undefined && (
              <CopyButton
                text={copyText}
                label={copyLabel}
                iconStyle={styles.copyIcon}
              />
            )}
            <button
              type="button"
              {...stylex.props(styles.dialogClose)}
              aria-label="Close"
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          </div>
        </header>
        <div {...stylex.props(styles.dialogBody)}>{children}</div>
      </div>
    </div>,
    portalTarget,
  );
}

/** Keeps Tab and Shift+Tab cycling within the open dialog. */
function trapTab(event: KeyboardEvent, dialog: HTMLElement | null): void {
  if (!dialog) return;

  const focusable = [
    ...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ];

  const first = focusable[0];
  const last = focusable.at(-1);
  const active = document.activeElement;

  if (!first || !last) {
    event.preventDefault();
    dialog.focus();
  } else if (!dialog.contains(active)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && (active === first || active === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/** The full-viewer body for an already-loaded excerpt or file: highlighted,
 * line-numbered, uncapped — the dialog itself bounds the viewport. */
export function CodeFullViewerLines({
  startLine,
  code,
  language,
}: {
  startLine: number;
  code: string;
  language?: string | null;
}): ReactElement {
  const normalizedLanguage = normalizeMarkdownCodeLanguage(language ?? "");
  const codeFontSize = useContext(CodeFontSizeContext);

  return (
    <pre
      {...stylex.props(styles.fullViewerBody)}
      style={
        codeFontSize === undefined ? undefined : { fontSize: codeFontSize }
      }
    >
      <CodeExcerptSegmentLines
        segment={{ startLine, code }}
        normalizedLanguage={normalizedLanguage}
        relevantRanges={undefined}
        gapAfter={undefined}
      />
    </pre>
  );
}

/** "Source unavailable": the file/revision/side/range couldn't be loaded.
 * Source-dependent expansion and copy stay disabled; the card still shows
 * what the reader asked for, so they can tell a real gap from a typo. */
export function SourceUnavailableCard({
  file,
  side,
  revision,
  rangeLabel,
  reason,
}: {
  file: string;
  side?: string;
  revision?: string;
  rangeLabel: string;
  reason?: string;
}): ReactElement {
  return (
    <figure
      {...withClass(
        "code-peek-unavailable",
        styles.card,
        drawStyles.blockChild,
      )}
      role="note"
      aria-label={`Source unavailable: ${file}`}
    >
      <DiagramHeader
        kind="unavailable"
        title={file}
        meta={rangeLabel}
        xstyle={styles.header}
        metaStyle={styles.meta}
      />
      <div {...stylex.props(styles.unavailable)}>
        <p {...stylex.props(styles.unavailableTitle)}>Source unavailable</p>
        <dl {...stylex.props(styles.unavailableMeta)}>
          <div>
            <dt>File</dt>
            <dd>{file}</dd>
          </div>
          {side && (
            <div>
              <dt>Side</dt>
              <dd>{side}</dd>
            </div>
          )}
          {revision && (
            <div>
              <dt>Revision</dt>
              <dd>{revision}</dd>
            </div>
          )}
          <div>
            <dt>Requested range</dt>
            <dd>{rangeLabel}</dd>
          </div>
        </dl>
        {reason && <p {...stylex.props(styles.unavailableReason)}>{reason}</p>}
      </div>
    </figure>
  );
}

const narrow = "@media (max-width: 640px)";

const styles = stylex.create({
  card: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    overflow: "hidden",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.rule,
    borderRadius: radius.surface,
    backgroundColor: tokens.surface,
  },
  header: {
    paddingRight: "8px",
  },
  meta: {
    marginLeft: 0,
  },
  copy: {},
  copyIcon: {
    width: "14px",
    height: "14px",
    strokeWidth: "1.5px",
  },
  body: {
    display: "block",
    margin: 0,
    overflow: "auto",
    overscrollBehavior: "contain",
    color: tokens.ink,
    font: `${fontSize.ui}/20px ${tokens.fontMono}`,
    textAlign: "left",
  },
  line: {
    display: "grid",
    minWidth: 0,
    gridTemplateColumns: "42px minmax(0, 1fr)",
    minHeight: "20px",
    whiteSpace: "pre",
  },
  lineContext: {
    opacity: 0.55,
  },
  gutter: {
    padding: "0 10px 0 0",
    color: tokens.ghost,
    textAlign: "right",
    userSelect: "none",
  },
  omission: {
    padding: "2px 0 2px 42px",
    color: tokens.ghost,
    fontStyle: "italic",
    userSelect: "none",
  },
  empty: {
    padding: "8px 14px",
    color: tokens.inkFaint,
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    marginLeft: "auto",
  },
  toggle: {
    justifyContent: "center",
    gap: "6px",
    width: "100%",
    borderRadius: 0,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: tokens.ruleSoft,
  },
  unavailable: {
    padding: "10px 14px 14px",
  },
  unavailableTitle: {
    margin: "0 0 6px",
    fontWeight: fontWeight.semibold,
  },
  unavailableMeta: {
    display: "grid",
    gap: "2px",
    margin: "0 0 6px",
    font: `${fontSize.small}/16px ${tokens.fontMono}`,
  },
  unavailableReason: {
    margin: 0,
    color: tokens.inkFaint,
  },
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: layer.dialog,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: tokens.backdrop,
  },
  dialog: {
    display: "flex",
    flexDirection: "column",
    width: "min(880px, 100%)",
    maxHeight: "min(80vh, 760px)",
    minWidth: 0,
  },
  dialogHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "12px",
    padding: "14px 14px 10px",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: tokens.ruleSoft,
  },
  dialogHeading: {
    minWidth: 0,
  },
  dialogTitle: {
    margin: 0,
    fontSize: fontSize.ui,
    fontWeight: fontWeight.semibold,
    lineHeight: "20px",
    overflowWrap: "anywhere",
  },
  dialogIdentity: {
    margin: "2px 0 0",
    color: tokens.inkFaint,
    font: `${fontSize.small}/16px ${tokens.fontMono}`,
  },
  dialogActions: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flex: "0 0 auto",
  },
  dialogClose: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "28px",
    height: "28px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.ruleSoft,
    borderRadius: radius.control,
    backgroundColor: "transparent",
    cursor: "pointer",
  },
  dialogBody: {
    minHeight: 0,
    flex: "1 1 auto",
    overflow: "auto",
    [narrow]: { padding: "0 4px" },
  },
  fullViewerBody: {
    display: "block",
    margin: 0,
    padding: "8px 14px 14px",
    color: tokens.ink,
    font: `${fontSize.ui}/20px ${tokens.fontMono}`,
    textAlign: "left",
  },
});
