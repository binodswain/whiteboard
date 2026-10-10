import { fontSize, radius } from "@canvas/scale.stylex";
import * as stylex from "@stylexjs/stylex";
import { type ComponentProps, type ReactElement, useContext } from "react";

import { CodeFontSizeContext } from "./code-font-size";
import {
  countLines,
  normalizeMarkdownCodeLanguage,
  renderHighlightedCode,
  useHighlightedTokens,
} from "./code-highlighting";
import { CopyButton } from "./copy-text";
import { DiagramHeader } from "./diagram-header";
import { drawStyles } from "./draw-styles";
import { documentMarker } from "./markers.stylex";
import { withClass } from "./stylex-props";
import { tokens } from "./tokens.stylex";

export interface RenderedCodeBlockProps extends ComponentProps<"pre"> {
  code: string;
  language?: string | null;
  /** Header title; a fenced markdown block has none. */
  caption?: string;
  /** Ghost line numbers in a sticky gutter; off for fenced markdown. */
  lineNumbers?: boolean;
  /** Tighter block margins, for a chat message. */
  compact?: boolean;
  codeAttributes?: Record<string, string>;
}

/** A code figure: the same header as the other figures (language badge,
 * caption, line count, copy), then the highlighted code. */
export function RenderedCodeBlock({
  code,
  language,
  caption,
  lineNumbers = false,
  compact = false,
  codeAttributes,
  className,
  ...props
}: RenderedCodeBlockProps): ReactElement {
  const codeFontSize = useContext(CodeFontSizeContext);
  const normalizedLanguage = normalizeMarkdownCodeLanguage(language ?? "");
  const highlightedTokens = useHighlightedTokens(code, normalizedLanguage);

  const displayLanguage = normalizedLanguage ?? language?.trim() ?? undefined;
  const lineCount = countLines(code);

  return (
    <figure
      {...(className
        ? withClass(
            className,
            styles.block,
            compact && styles.compact,
            drawStyles.blockChild,
          )
        : stylex.props(
            styles.block,
            compact && styles.compact,
            drawStyles.blockChild,
          ))}
      data-language={displayLanguage}
    >
      <DiagramHeader
        kind={displayLanguage || "code"}
        title={caption}
        meta={`${lineCount} ${lineCount === 1 ? "line" : "lines"}`}
        xstyle={styles.header}
        metaStyle={styles.meta}
        action={
          <CopyButton
            text={code}
            label="Copy"
            xstyle={styles.copy}
            iconStyle={styles.copyIcon}
          />
        }
      />
      <pre
        {...props}
        {...stylex.props(styles.body)}
        style={
          codeFontSize === undefined
            ? props.style
            : { ...props.style, fontSize: codeFontSize }
        }
      >
        {lineNumbers && (
          <span aria-hidden="true" {...stylex.props(styles.gutter)}>
            {Array.from({ length: lineCount }, (_, index) => index + 1).join(
              "\n",
            )}
          </span>
        )}
        <code
          {...codeAttributes}
          {...stylex.props(styles.code)}
          data-review-copy-prose
        >
          {renderHighlightedCode(code, normalizedLanguage, highlightedTokens)}
        </code>
      </pre>
    </figure>
  );
}

const inDocument = () => stylex.when.ancestor(":is(*)", documentMarker);

// A block's own element: a child of the block's node.
const inDocumentBlock = () => `${inDocument()}:is([data-review-node-id] > *)`;

// The same figure as a diagram: hairline frame, tray header with the language
// as its kind, the caption as its title, a line count and an icon-only copy
// button; then the code, scrolling sideways, never wrapping.
const styles = stylex.create({
  block: {
    minWidth: 0,
    maxWidth: {
      default: "100%",
      // A document block sits in the prose column.
      [inDocumentBlock()]: `calc(100cqi - 2 * ${tokens.reviewDocumentPaddingInline})`,
    },
    width: {
      default: null,
      [inDocumentBlock()]: `min(100%, ${tokens.reviewBlockMaxWidth})`,
    },
    marginInline: {
      default: null,
      [inDocumentBlock()]: "auto",
    },
    marginBlock: "24px",
    overflow: "hidden",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.rule,
    borderRadius: radius.surface,
    backgroundColor: tokens.surface,
  },
  compact: {
    marginBlock: "8px",
  },
  header: {
    paddingRight: "8px",
  },
  meta: {
    marginLeft: 0,
  },
  copy: {
    marginLeft: "auto",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.ruleSoft,
    backgroundColor: {
      default: tokens.surface,
      ":hover": tokens.well,
      ":is([data-copied])": tokens.well,
    },
  },
  copyIcon: {
    width: "14px",
    height: "14px",
    strokeWidth: "1.5px",
  },
  body: {
    display: "flex",
    margin: 0,
    overflowX: "auto",
    color: tokens.ink,
    font: `${fontSize.ui}/20px ${tokens.fontMono}`,
    textAlign: "left",
  },
  code: {
    display: "block",
    flex: "1 0 auto",
    padding: "12px 14px",
    borderRadius: 0,
    backgroundColor: tokens.transparent,
    color: "inherit",
    font: "inherit",
    whiteSpace: "pre",
    // As the editor shows tabs; the browser's eight push indented code
    // off the block.
    tabSize: 4,
  },
  gutter: {
    position: "sticky",
    left: 0,
    flex: "0 0 auto",
    minWidth: "50px",
    padding: "12px 14px",
    backgroundColor: tokens.surface,
    color: tokens.ghost,
    textAlign: "right",
    whiteSpace: "pre",
    userSelect: "none",
  },
});
