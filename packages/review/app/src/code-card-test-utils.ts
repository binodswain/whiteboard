import { act } from "react";

/** Opens a code card's "More actions" menu and picks the item named `label`. */
export async function chooseCardAction(
  scope: ParentNode,
  label: string,
): Promise<void> {
  const trigger = scope.querySelector<HTMLButtonElement>(
    'button[aria-label="More actions"]',
  );

  if (!trigger) throw new Error("No More actions menu in scope.");

  await act(async () => trigger.click());

  const item = [
    ...document.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
  ].find((candidate) => candidate.textContent === label);

  if (!item) throw new Error(`No "${label}" item in the open menu.`);

  await act(async () => item.click());
}

/** The "More actions" menu item named `label`, with the menu left open. */
export async function findCardAction(
  scope: ParentNode,
  label: string,
): Promise<HTMLElement | undefined> {
  await act(async () =>
    scope
      .querySelector<HTMLButtonElement>('button[aria-label="More actions"]')
      ?.click(),
  );

  return [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(
    (candidate) => candidate.textContent === label,
  );
}
