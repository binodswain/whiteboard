import { IconButton } from "@canvas/ui/button";
import { menuStyles } from "@canvas/ui/menu";
import { surfaceStyles } from "@canvas/ui/surface";
import { useAnchoredPopover } from "@canvas/use-anchored-popover";
import { useDismissOnOutside } from "@canvas/use-dismiss-on-outside";
import * as stylex from "@stylexjs/stylex";
import { type ReactElement, useContext, useRef, useState } from "react";

import { useCurrentReviewSnapshot } from "./api-canvas";
import { controlStyles } from "./controls-styles";
import {
  exportFilename,
  exportHtml,
  exportMarkdown,
} from "./export/document-export";
import { CanvasUiContext, useCanvasMenu } from "./host/canvas-ui";
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
  const ui = useContext(CanvasUiContext);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const popover = useAnchoredPopover(open, anchor);

  useDismissOnOutside(anchor, open, setOpen);

  const select = (id: string) => {
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
  };

  const menu = useCanvasMenu({
    items: OPTIONS.map(({ id, label }) => ({ id, label })),
    onSelect: select,
  });

  // Only the desktop host supplies a canvas UI; elsewhere (web) render the
  // menu in-page instead of leaving the trigger disabled.
  const triggerProps = ui
    ? menu.triggerProps
    : {
        "aria-haspopup": "menu" as const,
        "aria-expanded": open,
        onClick: () => setOpen((current) => !current),
      };

  // Header renders for non-ApiCanvas content too (scratchpad, tests); export
  // only makes sense with a review snapshot.
  if (!snapshot) return null;

  return (
    <div ref={anchor} {...stylex.props(styles.control)}>
      <IconButton
        xstyle={shellStyles.topbarItem}
        ref={tooltip}
        aria-label="Export review"
        {...triggerProps}
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
      {!ui && open ? (
        <div
          ref={popover}
          popover="manual"
          role="menu"
          aria-label="Export review"
          {...stylex.props(
            surfaceStyles.popover,
            menuStyles.popover,
            menuStyles.end,
          )}
        >
          {OPTIONS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="menuitem"
              {...stylex.props(menuStyles.item)}
              onClick={() => {
                setOpen(false);
                select(id);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const styles = stylex.create({ control: { position: "relative" } });
