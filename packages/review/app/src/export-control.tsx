import { IconButton } from "@canvas/ui/button";
import * as stylex from "@stylexjs/stylex";
import type { ReactElement } from "react";

import { useCurrentReviewSnapshot } from "./api-canvas";
import { controlStyles } from "./controls-styles";
import {
  exportFilename,
  exportHtml,
  exportMarkdown,
} from "./export/document-export";
import { useCanvasMenu } from "./host/canvas-ui";
import { shellStyles } from "./shell-styles";
import { useTooltip } from "./use-tooltip";

const OPTIONS = [
  { id: "markdown", label: "Export as Markdown" },
  { id: "html", label: "Export as HTML" },
  { id: "print", label: "Print / Save as PDF" },
] as const;

function download(content: string, mimeType: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ExportControl(): ReactElement | null {
  const snapshot = useCurrentReviewSnapshot();
  const tooltip = useTooltip("Export review");

  const menu = useCanvasMenu({
    items: OPTIONS.map(({ id, label }) => ({ id, label })),
    onSelect: (id) => {
      if (!snapshot) return;

      if (id === "markdown") {
        download(
          exportMarkdown(snapshot),
          "text/markdown",
          exportFilename(snapshot, "md"),
        );
      } else if (id === "html") {
        download(
          exportHtml(snapshot),
          "text/html",
          exportFilename(snapshot, "html"),
        );
      } else if (id === "print") {
        const printWindow = window.open("", "_blank");

        if (!printWindow) return;
        printWindow.document.open();
        printWindow.document.write(exportHtml(snapshot));
        printWindow.document.close();
        // about:blank popups may never fire a load event for written content;
        // defer past document.close instead so print() reliably runs.
        setTimeout(() => printWindow.print(), 0);
      }
    },
  });

  // Header renders for non-ApiCanvas content too (scratchpad, tests); export
  // only makes sense with a review snapshot.
  if (!snapshot) return null;

  return (
    <div {...stylex.props(styles.control)}>
      <IconButton
        xstyle={shellStyles.topbarItem}
        ref={tooltip}
        aria-label="Export review"
        {...menu.triggerProps}
      >
        <svg
          {...stylex.props(controlStyles.chromeIcon)}
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M12 3v12m0 0 4-4m-4 4-4-4M5 16v4h14v-4"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </IconButton>
    </div>
  );
}

const styles = stylex.create({ control: { position: "relative" } });
