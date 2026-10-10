import type {
  ReviewInlineEditorSpec,
  ReviewVerbRequest,
} from "@dev.fast/review-protocol";
import { selectSource, sourceAnchors } from "@review/lens-selection";
import { type ReactNode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodePeek, CodePeekCard, CodePeekGroup } from "./CodePeek";
import {
  type ReviewSession,
  ReviewSessionProvider,
} from "./host/review-session";
import type { ReviewLensView } from "./review-lenses";
import { testReviewSession } from "./review-session-test-utils";

const testLenses: ReviewLensView = {
  progress: null,
  error: null,
  resolve: (selections) => selections.flatMap(sourceAnchors),
};

let root: ReturnType<typeof createRoot> | undefined;

let posted: ReviewVerbRequest[] = [];

let created: ReviewInlineEditorSpec[] = [];

let disposed: ReviewInlineEditorSpec[] = [];

let session: ReviewSession;

beforeEach(() => {
  posted = [];
  created = [];
  disposed = [];
  session = createTestSession();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CodePeek native editor", () => {
  it("renders API file content as a highlighted, copyable compact card on the web", async () => {
    session = createTestSession("web-session", "web");

    const fetch = vi
      .spyOn(session, "fetch")
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ text: "zero\none\ntwo\nthree" })),
      );

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <CodePeekCard
          source={selectSource({
            side: "head",
            file: "src/current.ts",
            fromLine: 2,
            toLine: 3,
          })}
          lenses={testLenses}
        />,
      );
    });

    await vi.waitFor(() =>
      expect(container.querySelector("pre")?.textContent).toContain("one"),
    );

    const lines = [...container.querySelectorAll("pre > div")];

    expect(lines).toHaveLength(2);
    expect(lines[0]?.textContent).toBe("2one");
    expect(lines[1]?.textContent).toBe("3two");
    expect(fetch).toHaveBeenCalledWith(
      "/file?side=head&file=src%2Fcurrent.ts",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(container.querySelector("[data-review-inline-editor]")).toBeNull();
    expect(container.textContent).toContain("src/current.ts");
    expect(
      container.querySelector('button[aria-label="Copy excerpt"]'),
    ).not.toBeNull();
    expect(
      [...container.querySelectorAll("button")].some((b) =>
        b.textContent?.includes("Show surrounding context"),
      ),
    ).toBe(true);
  });

  it("renders map and grouped code peeks from the API on the web", async () => {
    session = createTestSession("web-session", "web");

    const fetch = vi
      .spyOn(session, "fetch")
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ text: "zero\none\ntwo\nthree" })),
      );

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <>
          <CodePeek
            file="src/map.ts"
            fromLine={2}
            toLine={3}
            graph="head"
            lenses={testLenses}
          />
          <CodePeekGroup
            peeks={[
              {
                file: "src/group.ts",
                fromLine: 2,
                toLine: 3,
                side: "head",
              },
            ]}
            lenses={testLenses}
          />
        </>,
      );
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(container.querySelectorAll("pre")).toHaveLength(2),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      container.querySelectorAll("[data-code-rendering='inline-editor']"),
    ).toHaveLength(0);
  });

  it("renders one native editor per authored file in a grouped side peek", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <CodePeekGroup
          lenses={testLenses}
          peeks={[
            {
              file: "src/current.ts",
              fromLine: 20,
              toLine: 24,
              side: "head",
            },
            {
              file: "src/current.ts",
              fromLine: 22,
              toLine: 23,
              side: "head",
            },
            {
              file: "src/current.ts",
              fromLine: 80,
              toLine: 82,
              side: "head",
            },
            {
              file: "src/current.ts",
              fromLine: 50,
              toLine: 50,
              side: "base",
            },
            {
              file: "src/other.ts",
              fromLine: 4,
              toLine: 4,
              side: "head",
            },
          ]}
        />,
      );
    });

    await vi.waitFor(() => expect(created).toHaveLength(2));
    expect(created).toMatchObject([
      {
        path: "src/current.ts",
        side: "head",
        countRanges: [
          { startLine: 20, endLine: 24, side: "head" },
          { startLine: 22, endLine: 23, side: "head" },
          { startLine: 80, endLine: 82, side: "head" },
          { startLine: 50, endLine: 50, side: "base" },
        ],
        ranges: [
          { startLine: 20, endLine: 24 },
          { startLine: 80, endLine: 82 },
          { startLine: 50, endLine: 50, side: "base" },
        ],
        heightMode: "content",
      },
      {
        path: "src/other.ts",
        ranges: [{ startLine: 4, endLine: 4 }],
        heightMode: "content",
      },
    ]);
  });

  it("lets the software-map sidebar scroll one content-height diff feed", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <CodePeek
          file="src/current.ts"
          fromLine={20}
          toLine={24}
          graph="head"
          lenses={testLenses}
        />,
      );
    });

    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({
      path: "src/current.ts",
      ranges: [{ startLine: 20, endLine: 24 }],
      heightMode: "content",
    });
  });

  it("mounts each editor without a React header and opens from the native action", async () => {
    const input = {
      side: "base",
      file: "src/previous.ts",
      fromLine: 7,
      toLine: 9,
    } as const;

    const secondInput = {
      side: "head",
      file: "src/current.ts",
      fromLine: 20,
      toLine: 20,
    } as const;

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () =>
      renderWithSession(
        <>
          <CodePeekCard source={selectSource(input)} lenses={testLenses} />
          <CodePeekCard
            source={selectSource(secondInput)}
            lenses={testLenses}
          />
        </>,
      ),
    );
    await vi.waitFor(() => {
      expect(created).toMatchObject([
        {
          path: "src/previous.ts",
          side: "base",
          title: "src/previous.ts:7-9",
          heightMode: "capped",
        },
        {
          path: "src/current.ts",
          side: "head",
          title: "src/current.ts:20",
          heightMode: "capped",
        },
      ]);
    });
    expect(
      [...container.querySelectorAll("[data-review-inline-editor]")].every(
        (placeholder) =>
          placeholder.querySelector(".fixture-inline-editor") !== null,
      ),
    ).toBe(true);

    expect(container.querySelector(".code-peek-card")).toBeNull();
    expect(created[0]?.onDidOpen).toBeTypeOf("function");

    await act(async () => {
      created[0]?.onDidOpen?.();
    });

    expect(posted.at(-1)).toEqual({
      name: "reveal",
      args: {
        path: "src/previous.ts",
        startLine: 7,
        endLine: 9,
        side: "base",
        highlight: true,
        preserveFocus: false,
      },
    });
  });

  it("disposes every prior editor while rapidly retargeting one inline surface", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    for (let index = 0; index < 50; index += 1) {
      const input = {
        side: "head",
        file: `src/target-${index}.ts`,
        fromLine: index + 1,
        toLine: index + 1,
      } as const;

      await act(async () =>
        renderWithSession(
          <CodePeekCard source={selectSource(input)} lenses={testLenses} />,
        ),
      );
      await vi.waitFor(() => expect(created).toHaveLength(index + 1));
    }

    expect(created).toHaveLength(50);
    expect(disposed).toHaveLength(49);
    expect(
      container.querySelectorAll(
        "[data-review-inline-editor] > .fixture-inline-editor",
      ),
    ).toHaveLength(1);

    await act(async () => root!.unmount());
    root = undefined;
    expect(disposed).toHaveLength(50);
  });

  it("recreates a native editor when the Review session changes", async () => {
    const input = {
      side: "head",
      file: "src/current.ts",
      fromLine: 20,
      toLine: 20,
    } as const;

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () =>
      renderWithSession(
        <CodePeekCard source={selectSource(input)} lenses={testLenses} />,
      ),
    );
    await vi.waitFor(() => expect(created).toHaveLength(1));

    session = createTestSession("next-session");
    await act(async () =>
      renderWithSession(
        <CodePeekCard source={selectSource(input)} lenses={testLenses} />,
      ),
    );

    await vi.waitFor(() => {
      expect(disposed).toHaveLength(1);
      expect(created).toHaveLength(2);
    });
  });

  it("widens the native editor's displayed range on Show surrounding context, keeping the authored selection as countRanges", async () => {
    const input = {
      side: "head",
      file: "src/current.ts",
      fromLine: 20,
      toLine: 24,
    } as const;

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () =>
      renderWithSession(
        <CodePeekCard source={selectSource(input)} lenses={testLenses} />,
      ),
    );
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({
      ranges: [{ startLine: 20, endLine: 24 }],
      countRanges: [{ startLine: 20, endLine: 24, side: "head" }],
    });

    const toggle = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Show surrounding context"),
    )!;

    await act(async () => toggle.click());
    await vi.waitFor(() => expect(created).toHaveLength(2));

    expect(created.at(-1)).toMatchObject({
      ranges: [{ startLine: 15, endLine: 29 }],
      countRanges: [{ startLine: 20, endLine: 24, side: "head" }],
    });
    expect(
      container.querySelector('button[aria-expanded="true"]')?.textContent,
    ).toContain("Hide surrounding context");
    expect(container.querySelector(".code-peek-card")).toBeNull();
  });

  it("opens a named, focus-managed full-snippet dialog from the native surface and closes on Escape", async () => {
    const input = {
      side: "head",
      file: "src/current.ts",
      fromLine: 20,
      toLine: 24,
    } as const;

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () =>
      renderWithSession(
        <CodePeekCard source={selectSource(input)} lenses={testLenses} />,
      ),
    );
    await vi.waitFor(() => expect(created).toHaveLength(1));

    const openButton = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Open full snippet",
    )!;

    await act(async () => openButton.click());

    const dialog = document.querySelector('[role="dialog"]');

    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.textContent).toContain("src/current.ts");
    expect(document.activeElement).toBe(dialog);

    // A second editor is created inside the dialog (same file, "full" variant).
    await vi.waitFor(() => expect(created).toHaveLength(2));
    expect(created.at(-1)).toMatchObject({
      path: "src/current.ts",
      heightMode: "content",
      active: true,
    });

    await act(async () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(openButton);
  });

  it("shows disjoint source ranges in one web card with a hidden-lines divider, merged when context is shown", async () => {
    session = createTestSession("web-session", "web");
    const text = Array.from({ length: 40 }, (_, i) => `l${i + 1}`).join("\n");

    vi.spyOn(session, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ text })),
    );

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <CodePeekGroup
          peeks={[
            { file: "src/current.ts", fromLine: 10, toLine: 12, side: "head" },
            { file: "src/current.ts", fromLine: 20, toLine: 22, side: "head" },
          ]}
          lenses={testLenses}
        />,
      );
    });

    await vi.waitFor(() => expect(container.textContent).toContain("l10"));

    expect(container.textContent).toMatch(/\d+ lines hidden/);
    expect(container.querySelectorAll("pre > div")).toHaveLength(7);

    const toggle = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Show surrounding context"),
    )!;

    await act(async () => toggle.click());

    expect(container.textContent).not.toMatch(/lines hidden/);
    expect(container.querySelectorAll("pre > div")).toHaveLength(23);
  });

  it("opens full snippet and full file web dialogs and restores focus on Escape", async () => {
    session = createTestSession("web-session", "web");
    const text = Array.from({ length: 10 }, (_, i) => `row${i}`).join("\n");

    vi.spyOn(session, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ text })),
    );

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <CodePeekCard
          source={selectSource({
            side: "head",
            file: "src/current.ts",
            fromLine: 3,
            toLine: 4,
          })}
          lenses={testLenses}
        />,
      );
    });

    await vi.waitFor(() => expect(container.textContent).toContain("row2"));

    const openFile = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Open full file",
    )!;

    await act(async () => openFile.click());

    const dialog = document.querySelector('[role="dialog"]');

    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.textContent).toContain("row9");
    expect(
      dialog?.querySelector('button[aria-label="Copy full file"]'),
    ).not.toBeNull();

    await act(async () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(openFile);
  });

  it("shows Source unavailable with file/side/revision identity when the web revision can't be loaded", async () => {
    session = createTestSession("web-session", "web");
    vi.spyOn(session, "fetch").mockImplementation(
      async () => new Response("not found", { status: 404 }),
    );

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <CodePeekCard
          source={selectSource({
            side: "head",
            file: "src/missing.ts",
            fromLine: 1,
            toLine: 2,
          })}
          lenses={testLenses}
        />,
      );
    });

    await vi.waitFor(() =>
      expect(container.textContent).toContain("Source unavailable"),
    );
    expect(container.textContent).toContain("src/missing.ts");
    expect(container.textContent).toContain("head");
    expect(
      container.querySelector('button[aria-label="Copy excerpt"]'),
    ).toBeNull();
  });

  it("treats an out-of-bounds web range as unavailable instead of silently clamping it", async () => {
    session = createTestSession("web-session", "web");
    vi.spyOn(session, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ text: "a\nb\nc" })),
    );

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <CodePeekCard
          source={selectSource({
            side: "head",
            file: "src/short.ts",
            fromLine: 1,
            toLine: 10,
          })}
          lenses={testLenses}
        />,
      );
    });

    await vi.waitFor(() =>
      expect(container.textContent).toContain("Source unavailable"),
    );
    expect(container.querySelectorAll("pre > div")).toHaveLength(0);
  });

  it("ignores a stale web fetch after the requested file changes mid-flight", async () => {
    session = createTestSession("web-session", "web");

    let resolveFirst: (() => void) | undefined;

    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    let call = 0;

    vi.spyOn(session, "fetch").mockImplementation(async (url) => {
      call += 1;

      if (call === 1) await firstGate;
      const file = new URL(String(url), "http://x").searchParams.get("file")!;
      const text = file === "src/a.ts" ? "AAA\nAAB" : "BBB\nBBC";

      return new Response(JSON.stringify({ text }));
    });

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    function Harness({ file }: { file: string }) {
      return (
        <CodePeekCard
          source={selectSource({
            side: "head",
            file,
            fromLine: 1,
            toLine: 2,
          })}
          lenses={testLenses}
        />
      );
    }

    await act(async () => renderWithSession(<Harness file="src/a.ts" />));
    await act(async () => renderWithSession(<Harness file="src/b.ts" />));

    resolveFirst?.();
    await vi.waitFor(() => expect(container.textContent).toContain("BBB"));
    expect(container.textContent).not.toContain("AAA");
  });
});

function renderWithSession(node: ReactNode) {
  root!.render(
    <ReviewSessionProvider session={session}>{node}</ReviewSessionProvider>,
  );
}

function createTestSession(
  reviewId = "test",
  surface: "desktop" | "web" = "desktop",
): ReviewSession {
  return testReviewSession(
    { reviewId, token: "", surface },
    {
      diffView: {
        files: async () => [],
        create: () => {
          throw new Error("unused test diff view");
        },
      },
      inlineEditors: {
        async find() {
          return { matchCount: 0 };
        },
        create: (spec) => {
          created.push(spec);
          const editor = document.createElement("div");
          editor.className = "fixture-inline-editor";
          spec.container.appendChild(editor);

          return {
            height: 180,
            setActive() {},
            setCollapsed() {},
            async setFindQuery() {
              return { matchCount: 0 };
            },
            revealFindMatch() {},
            clearActiveFindMatch() {},
            clearFind() {},
            onDidChangeHeight: () => ({ dispose() {} }),
            onDidError: () => ({ dispose() {} }),
            dispose: () => {
              disposed.push(spec);
              editor.remove();
            },
          };
        },
      },
      post: async (request) => {
        posted.push(request);

        return { ok: true };
      },
      subscribe: () => ({ dispose() {} }),
      currentTheme: () => "dark",
      onDidChangeTheme: () => ({ dispose() {} }),
      currentDiffLayout: () => "split",
      async setDiffLayout() {},
      onDidChangeDiffLayout: () => ({ dispose() {} }),
      ready() {},
    },
  );
}
