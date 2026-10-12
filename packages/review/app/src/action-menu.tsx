import { IconButton } from "@canvas/ui/button";
import { menuStyles } from "@canvas/ui/menu";
import { surfaceStyles } from "@canvas/ui/surface";
import { useAnchoredPopover } from "@canvas/use-anchored-popover";
import { useDismissOnOutside } from "@canvas/use-dismiss-on-outside";
import { useMenuKeyboard } from "@canvas/use-menu-keyboard";
import * as stylex from "@stylexjs/stylex";
import {
  type ReactElement,
  type RefObject,
  useContext,
  useRef,
  useState,
} from "react";

import { CanvasUiContext, useCanvasMenu } from "./host/canvas-ui";
import { CheckIcon, MoreIcon } from "./icons";
import { useTooltip } from "./use-tooltip";

export interface ActionMenuItem {
  id: string;
  label: string;
  /** Shown as a checked toggle rather than a one-shot command. */
  checked?: boolean;
  onSelect(): void;
}

/** An icon-only "more actions" menu for a figure's secondary commands, so
 * the primary action stays visible and the rest stay one click away.
 * The host's native menu when it supplies one, an in-page popover on the
 * web. */
export function ActionMenu({
  label,
  items,
  triggerRef,
  iconStyle,
  xstyle,
}: {
  label: string;
  items: readonly ActionMenuItem[];
  /** The trigger button, for a dialog that returns focus to it on close. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
  iconStyle?: stylex.StyleXStyles;
  xstyle?: stylex.StyleXStyles;
}): ReactElement {
  const ui = useContext(CanvasUiContext);
  const tooltip = useTooltip(label);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const popover = useAnchoredPopover(open, anchor);

  const { onKeyDown, restoreFocus } = useMenuKeyboard({
    open,
    container: anchor,
    menu: popover,
    close: () => setOpen(false),
  });

  useDismissOnOutside(anchor, open, setOpen);

  const select = (id: string) =>
    items.find((item) => item.id === id)?.onSelect();

  const menu = useCanvasMenu({
    items: items.map(({ id, label, checked }) => ({ id, label, checked })),
    onSelect: select,
  });

  const triggerProps = ui
    ? menu.triggerProps
    : {
        "aria-haspopup": "menu" as const,
        "aria-expanded": open,
        onClick: () => setOpen((current) => !current),
      };

  return (
    <div ref={anchor} {...stylex.props(styles.anchor)}>
      <IconButton
        ref={(node) => {
          const disposeTooltip = tooltip(node);

          if (triggerRef) triggerRef.current = node;

          return () => {
            disposeTooltip?.();

            if (triggerRef) triggerRef.current = null;
          };
        }}
        xstyle={xstyle}
        aria-label={label}
        {...triggerProps}
      >
        <MoreIcon xstyle={iconStyle} />
      </IconButton>
      {!ui && open ? (
        <div
          ref={popover}
          popover="manual"
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          {...stylex.props(
            surfaceStyles.popover,
            menuStyles.popover,
            menuStyles.end,
            styles.popover,
          )}
        >
          {items.map(({ id, label: itemLabel, checked }) => (
            <button
              key={id}
              type="button"
              role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={checked}
              tabIndex={-1}
              {...stylex.props(menuStyles.item)}
              onClick={() => {
                setOpen(false);
                restoreFocus();
                select(id);
              }}
            >
              <span {...stylex.props(styles.check)}>
                {checked ? <CheckIcon /> : null}
              </span>
              {itemLabel}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const styles = stylex.create({
  anchor: { position: "relative" },
  popover: { minWidth: "200px" },
  check: { display: "flex", width: "15px", height: "15px", flex: "none" },
});
