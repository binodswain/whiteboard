import { IconButton } from "@canvas/ui/button";
import * as stylex from "@stylexjs/stylex";
import { type ReactElement, useEffect, useState } from "react";

import { CheckIcon, CloseIcon, CopyIcon as CopyGlyph } from "./icons";
import { useTooltip } from "./use-tooltip";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);

    return true;
  } catch {
    // The workbench denies DOM clipboard permission requests.
  }

  const active = document.activeElement;
  const selection = document.getSelection();

  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) =>
        selection.getRangeAt(i).cloneRange(),
      )
    : [];

  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.style.position = "fixed";
  scratch.style.opacity = "0";
  document.body.appendChild(scratch);
  scratch.select();
  let copied = false;

  try {
    copied = document.execCommand("copy");
  } catch {
    // The caller keeps its default label when the copy fails.
  }

  scratch.remove();

  if (active instanceof HTMLElement) active.focus();

  if (selection && ranges.length) {
    selection.removeAllRanges();

    for (const range of ranges) selection.addRange(range);
  }

  return copied;
}

/** The prompt cards' copy glyph. */
export function CopyIcon() {
  return (
    <svg {...stylex.props(styles.icon)} viewBox="0 0 12 12" aria-hidden="true">
      <rect
        {...stylex.props(styles.stroke)}
        x="3.5"
        y="3.5"
        width="7"
        height="7"
        rx="1"
      />
      <path
        {...stylex.props(styles.stroke)}
        d="M8.5 3.5v-1a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h1"
      />
    </svg>
  );
}

const COPIED_FOR_MS = 1200;

/** An icon button that copies `text` and shows a check while it is copied,
 * or a cross when the copy failed; either outcome is also announced. */
export function CopyButton({
  text,
  label,
  className,
  xstyle,
  iconStyle,
}: {
  text: string;
  label: string;
  className?: string;
  xstyle?: stylex.StyleXStyles;
  iconStyle: stylex.StyleXStyles;
}): ReactElement {
  const [outcome, setOutcome] = useState<"copied" | "failed" | null>(null);
  const tooltip = useTooltip(label);

  useEffect(() => {
    if (!outcome) return;
    const timer = setTimeout(() => setOutcome(null), COPIED_FOR_MS);

    return () => clearTimeout(timer);
  }, [outcome]);

  return (
    <>
      <IconButton
        ref={tooltip}
        className={className}
        xstyle={xstyle}
        aria-label={label}
        data-copied={outcome === "copied" ? "" : undefined}
        data-copy-failed={outcome === "failed" ? "" : undefined}
        onClick={() => {
          // The workbench denies DOM clipboard requests; copyText falls back
          // to execCommand and reports whether anything was copied.
          void copyText(text).then((ok) => {
            setOutcome(ok ? "copied" : "failed");
          });
        }}
      >
        {outcome === "copied" ? (
          <CheckIcon xstyle={iconStyle} />
        ) : outcome === "failed" ? (
          <CloseIcon xstyle={iconStyle} />
        ) : (
          <CopyGlyph xstyle={iconStyle} />
        )}
      </IconButton>
      <span role="status" {...stylex.props(styles.visuallyHidden)}>
        {outcome === "copied"
          ? "Copied"
          : outcome === "failed"
            ? "Copy failed"
            : ""}
      </span>
    </>
  );
}

const styles = stylex.create({
  visuallyHidden: {
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
  icon: {
    width: "12px",
    height: "12px",
  },
  stroke: {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    strokeWidth: "1.2",
  },
});
