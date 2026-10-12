import { type ReactElement, useId, useRef, useState } from "react";

import { fingerprintText, useCodeCardExpanded } from "./code-card-state";
import {
  CodeExcerptCard,
  CodeFullViewerDialog,
  CodeFullViewerLines,
} from "./code-excerpt-card";
import type { PeekAnchor } from "./review-panel-model";

/** A 100-line standalone snippet initially shows its first 12 logical
 * lines; a shorter one shows completely. */
const STANDALONE_PREVIEW_LINES = 12;

/**
 * Standalone authored code shown in a side peek or tour stop: the shared
 * compact code card, with a bounded preview instead of source context.
 * Lines are numbered from the anchor's authored range when it has one,
 * otherwise from 1 — there is no repository anchor to resolve.
 */
export function AuthoredCodeSurface({
  anchor,
  code,
  language,
}: {
  anchor: PeekAnchor;
  code: string;
  language?: string;
}): ReactElement {
  const firstLine = anchor.peek?.start.line ?? 1;
  const normalized = code.replace(/\r\n?/g, "\n");
  const rawLines = normalized.split("\n");
  const hasTrailingNewline = rawLines.length > 1 && rawLines.at(-1) === "";
  const lines = hasTrailingNewline ? rawLines.slice(0, -1) : rawLines;
  const totalLines = lines.length;
  const truncatable = totalLines > STANDALONE_PREVIEW_LINES;

  const stateKey = `${anchor.id}:${fingerprintText(normalized)}:${
    language ?? ""
  }:${firstLine}`;

  const [expanded, setExpanded] = useCodeCardExpanded(stateKey, false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const actionsRef = useRef<HTMLButtonElement | null>(null);
  const regionId = useId();

  const showAll = expanded || !truncatable;
  const shownLines = showAll ? lines : lines.slice(0, STANDALONE_PREVIEW_LINES);
  const shownText = shownLines.join("\n");
  const fullText = lines.join("\n");

  const rangeLabel = truncatable
    ? `${shownLines.length} of ${totalLines} lines`
    : `${totalLines} ${totalLines === 1 ? "line" : "lines"}`;

  return (
    <>
      <CodeExcerptCard
        title={undefined}
        language={language}
        rangeLabel={rangeLabel}
        segments={[{ startLine: firstLine, code: shownText }]}
        omittedAfter={totalLines - shownLines.length}
        copyText={shownText}
        ariaLabel={
          language ? `${language} snippet, ${rangeLabel}` : "Code snippet"
        }
        scrollKey={stateKey}
        bodyId={regionId}
        toggle={
          truncatable
            ? {
                expanded,
                collapsedLabel: `Expand (${totalLines - STANDALONE_PREVIEW_LINES} more lines)`,
                expandedLabel: "Collapse",
                onToggle: () => setExpanded(!expanded),
              }
            : undefined
        }
        actions={[
          {
            id: "snippet",
            label: "Open full snippet",
            onSelect: () => setDialogOpen(true),
          },
        ]}
        actionsTriggerRef={actionsRef}
      />
      <CodeFullViewerDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        triggerRef={actionsRef}
        label={language ? `${language} snippet, full` : "Code snippet, full"}
        copyLabel="Copy full snippet"
        copyText={fullText}
      >
        <CodeFullViewerLines
          startLine={firstLine}
          code={fullText}
          language={language}
        />
      </CodeFullViewerDialog>
    </>
  );
}
