import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthoredCodeSurface } from "./authored-code-surface";
import { chooseCardAction } from "./code-card-test-utils";
import { ReviewSessionProvider } from "./host/review-session";
import type { PeekAnchor } from "./review-panel-model";
import { testReviewSession } from "./review-session-test-utils";

let root: Root | undefined;

const session = testReviewSession();

async function renderCard(anchor: PeekAnchor, code: string, language?: string) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ReviewSessionProvider session={session}>
        <AuthoredCodeSurface anchor={anchor} code={code} language={language} />
      </ReviewSessionProvider>,
    );
  });

  return container;
}

function gutterNumbers(container: HTMLElement): (string | null)[] {
  return [
    ...container.querySelectorAll('pre > div > span[aria-hidden="true"]'),
  ].map((el) => el.textContent);
}

const anchor = (id = "snippet"): PeekAnchor => ({ id, title: "Snippet" });

const codeLines = (scope: ParentNode) => [
  ...scope.querySelectorAll("pre > div:not([data-code-omission])"),
];

const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.startsWith(text),
  )!;

describe("AuthoredCodeSurface", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("shows a short snippet completely, with no expand control", async () => {
    const code = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );

    const container = await renderCard(anchor(), code);

    expect(gutterNumbers(container)).toEqual(["1", "2", "3", "4", "5"]);
    expect(container.textContent).toContain("5 lines");
    expect(
      [...container.querySelectorAll("button")].some((b) =>
        b.textContent?.includes("Expand"),
      ),
    ).toBe(false);
  });

  it("shows only the first 12 lines of a 100-line snippet, with an expand control", async () => {
    const code = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );

    const container = await renderCard(anchor(), code);

    expect(codeLines(container)).toHaveLength(12);
    expect(container.textContent).toContain("12 of 100 lines");
    expect(
      container.querySelector("[data-code-omission]")?.textContent,
    ).toContain("88 more lines hidden");

    const expandButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Expand"),
    )!;

    expect(expandButton.textContent).toContain("88 more");

    await act(async () => expandButton.click());

    expect(codeLines(container)).toHaveLength(100);
    expect(container.querySelector("[data-code-omission]")).toBeNull();
    expect(container.textContent).toContain("100 lines");
    expect(
      [...container.querySelectorAll("button")].some(
        (b) => b.textContent === "Collapse",
      ),
    ).toBe(true);
  });

  it("persists expansion across a remount of the same step, scoped to this item", async () => {
    const code = Array.from({ length: 50 }, (_, i) => `x${i}`).join("\n");

    const first = await renderCard(anchor("step-a"), code);

    const expandButton = [...first.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Expand"),
    )!;

    await act(async () => expandButton.click());
    expect(first.querySelectorAll("pre > div")).toHaveLength(50);

    act(() => root?.unmount());
    document.body.replaceChildren();

    // Re-mounting the same anchor/content restores the expanded state...
    const second = await renderCard(anchor("step-a"), code);

    expect(second.querySelectorAll("pre > div")).toHaveLength(50);

    act(() => root?.unmount());
    document.body.replaceChildren();

    // ...but a different step's identical-looking code starts collapsed.
    const third = await renderCard(anchor("step-b"), code);

    expect(codeLines(third)).toHaveLength(12);
  });

  it("copies only the currently displayed preview text, not the full snippet", async () => {
    const code = Array.from({ length: 20 }, (_, i) => `v${i}`).join("\n");
    const container = await renderCard(anchor(), code);

    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();

    const copyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy excerpt"]',
    )!;

    await act(async () => copyButton.click());

    expect(writeText).toHaveBeenCalledWith(
      Array.from({ length: 12 }, (_, i) => `v${i}`).join("\n"),
    );
  });

  it("opens the full snippet in a named, focus-managed dialog and restores focus on Escape", async () => {
    const code = Array.from({ length: 30 }, (_, i) => `n${i}`).join("\n");
    const container = await renderCard(anchor(), code, "ts");

    await chooseCardAction(container, "Open full snippet");

    const dialog = document.querySelector('[role="dialog"]');

    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.querySelectorAll("pre > div")).toHaveLength(30);
    expect(dialog?.textContent).toContain("n29");
    expect(
      dialog?.querySelector('button[aria-label="Copy full snippet"]'),
    ).not.toBeNull();
    expect(document.activeElement).toBe(dialog);

    await act(async () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('button[aria-label="More actions"]'),
    );
  });

  it("numbers lines from the anchor's authored starting line", async () => {
    const container = await renderCard(
      {
        id: "ranged",
        title: "Ranged",
        peek: {
          file: "x.ts",
          start: { side: "head", line: 41 },
          end: { side: "head", line: 43 },
        },
      } as PeekAnchor,
      "a\nb\nc",
    );

    expect(gutterNumbers(container)).toEqual(["41", "42", "43"]);
  });

  it("renders without a filename, never inventing a source association", async () => {
    const container = await renderCard(anchor(), "const x = 1;", "ts");

    expect(
      container.querySelector("figure")?.getAttribute("data-language"),
    ).toBe("ts");
    expect(container.querySelector("code")?.textContent).toContain(
      "const x = 1;",
    );
  });

  it("names the code region it expands and keeps the expanded snippet within the height cap", async () => {
    const code = Array.from({ length: 30 }, (_, i) => `  e${i}();`).join("\n");
    const container = await renderCard(anchor(), code, "ts");
    const expand = button(container, "Expand");

    const region = document.getElementById(
      expand.getAttribute("aria-controls")!,
    );

    expect(region?.tagName).toBe("PRE");

    await act(async () => expand.click());

    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(region?.style.maxHeight).toBe("240px");

    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Copy excerpt"]')!
        .click(),
    );

    // Indentation kept; no gutters or omission markers.
    expect(writeText).toHaveBeenCalledWith(code);
  });

  it("keeps Tab inside the full viewer", async () => {
    const code = Array.from({ length: 30 }, (_, i) => `t${i}`).join("\n");
    const container = await renderCard(anchor(), code);

    await chooseCardAction(container, "Open full snippet");

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const buttons = [...dialog.querySelectorAll("button")];

    buttons.at(-1)!.focus();
    await act(async () =>
      buttons
        .at(-1)!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
        ),
    );

    expect(document.activeElement).toBe(buttons[0]);

    await act(async () =>
      buttons[0]!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
        }),
      ),
    );

    expect(document.activeElement).toBe(buttons.at(-1));
  });

  it("reports a failed copy instead of staying silent", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new Error("denied"),
    );
    vi.spyOn(document, "execCommand").mockReturnValue(false);
    const container = await renderCard(anchor(), "a\nb");

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Copy excerpt"]')!
        .click(),
    );

    await vi.waitFor(() =>
      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        "Copy failed",
      ),
    );
  });
});
