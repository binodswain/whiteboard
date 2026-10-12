import { motion, radius } from "@canvas/scale.stylex";
import { tokens } from "@canvas/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactElement } from "react";

/**
 * A thin bar for work that is under way. Without `percent` the bar is
 * indeterminate: use that when the host cannot say how far along it is.
 */
export function ProgressBar({
  label,
  percent,
}: {
  label: string;
  percent?: number;
}): ReactElement {
  const determinate = percent !== undefined;
  const clamped = determinate ? Math.min(100, Math.max(0, percent)) : 0;

  return (
    <div
      {...stylex.props(styles.track)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={determinate ? Math.round(clamped) : undefined}
    >
      <div
        {...stylex.props(styles.fill, !determinate && styles.indeterminate)}
        style={determinate ? { width: `${clamped}%` } : undefined}
      />
    </div>
  );
}

const slide = stylex.keyframes({
  from: { transform: "translateX(-100%)" },
  to: { transform: "translateX(250%)" },
});

const styles = stylex.create({
  track: {
    position: "relative",
    overflow: "hidden",
    height: "4px",
    borderRadius: radius.hairline,
    backgroundColor: tokens.well,
  },
  fill: {
    height: "100%",
    borderRadius: radius.hairline,
    backgroundColor: tokens.accent,
  },
  indeterminate: {
    width: "40%",
    animationName: slide,
    animationDuration: motion.pulse,
    animationTimingFunction: motion.ease,
    animationIterationCount: "infinite",
    "@media (prefers-reduced-motion: reduce)": {
      animationName: "none",
      width: "100%",
      opacity: 0.5,
    },
  },
});
