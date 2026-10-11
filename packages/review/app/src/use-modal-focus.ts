import { type KeyboardEvent, type RefObject, useEffect } from "react";

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * The focus half of a modal dialog: Tab and Shift+Tab stay inside it, and
 * closing it returns focus to the control that opened it. The caller sets
 * `opener` when it opens the dialog, since by the time the dialog renders
 * focus may already have left that control.
 */
export function useModalFocus({
  open,
  dialog,
  opener,
}: {
  open: boolean;
  dialog: RefObject<HTMLElement | null>;
  opener: RefObject<HTMLElement | null>;
}) {
  useEffect(() => {
    if (!open) return;

    return () => {
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, [open, opener]);

  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;

    const items = [
      ...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
    ];

    const first = items[0];
    const last = items.at(-1);

    if (!first || !last) return;

    if (!dialog.current?.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
}
