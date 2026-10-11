import * as stylex from "@stylexjs/stylex";
import { type KeyboardEvent, useRef } from "react";

import { controlStyles } from "./controls-styles";

const styles = stylex.create({
  // Narrow containers wrap the segments instead of overflowing the row.
  group: { flexWrap: "wrap", maxWidth: "100%" },
});

export function Choice<T extends string>({
  label,
  value,
  labels,
  disabled = false,
  onChange,
}: {
  label: string;
  value: T;
  labels: Record<T, string>;
  disabled?: boolean;
  onChange: (choice: T) => void;
}) {
  // SAFETY: `labels` is declared as Record<T, string>, so its own keys are
  // exactly the T choices this control offers.
  const choices = Object.keys(labels) as T[];
  const buttons = useRef(new Map<T, HTMLButtonElement>());

  // One tab stop: the checked choice, or the first when none matches.
  const stop = choices.includes(value) ? value : choices[0];

  const move = (event: KeyboardEvent, from: number) => {
    const last = choices.length - 1;

    const target =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? (from + 1) % choices.length
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? (from - 1 + choices.length) % choices.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : undefined;

    if (target === undefined) return;

    event.preventDefault();

    const choice = choices[target]!;

    buttons.current.get(choice)?.focus();

    if (choice !== value) onChange(choice);
  };

  return (
    <div
      {...stylex.props(controlStyles.segmented, styles.group)}
      role="radiogroup"
      aria-label={label}
    >
      {choices.map((choice, index) => (
        <button
          key={choice}
          ref={(node) => {
            if (node) buttons.current.set(choice, node);
            else buttons.current.delete(choice);
          }}
          type="button"
          role="radio"
          aria-checked={choice === value}
          tabIndex={choice === stop ? 0 : -1}
          disabled={disabled}
          {...stylex.props(
            controlStyles.segment,
            controlStyles.segmentLarge,
            choice === value && controlStyles.segmentActive,
          )}
          onClick={() => onChange(choice)}
          onKeyDown={(event) => move(event, index)}
        >
          {labels[choice]}
        </button>
      ))}
    </div>
  );
}
