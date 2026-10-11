import { type KeyboardEvent, type RefObject, useEffect } from "react";

const ITEM = '[role^="menuitem"]';

/**
 * The keyboard model for an in-page menu: opening focuses the checked item
 * (else the first), arrows wrap, Home and End jump, Escape and Tab close, and
 * closing by Escape or selection returns focus to the trigger. `view` names
 * which set of items the menu shows, so a swap between views refocuses.
 */
export function useMenuKeyboard({
  open,
  container,
  menu,
  close,
  view,
}: {
  open: boolean;
  container: RefObject<HTMLElement | null>;
  menu: RefObject<HTMLElement | null>;
  close(): void;
  view?: string;
}) {
  const restoreFocus = () =>
    container.current
      ?.querySelector<HTMLElement>('[aria-haspopup="menu"]')
      ?.focus();

  useEffect(() => {
    if (!open) return;

    const element = menu.current;

    (
      element?.querySelector<HTMLElement>(`${ITEM}[aria-checked="true"]`) ??
      element?.querySelector<HTMLElement>(`${ITEM}, select, button`)
    )?.focus();
  }, [open, menu, view]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      restoreFocus();

      return;
    }

    if (event.key === "Tab") {
      close();

      return;
    }

    // Arrow keys belong to controls inside a menu, such as a select.
    if (!(event.target instanceof HTMLElement) || !event.target.matches(ITEM))
      return;

    const items = [
      ...(menu.current?.querySelectorAll<HTMLElement>(ITEM) ?? []),
    ];

    const index = items.indexOf(event.target);

    let next: number | undefined;

    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    else if (event.key === "ArrowUp")
      next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;

    if (next === undefined) return;
    event.preventDefault();
    items[next]?.focus();
  };

  return { onKeyDown, restoreFocus };
}
