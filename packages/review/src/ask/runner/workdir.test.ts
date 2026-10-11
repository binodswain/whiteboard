import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WORKDIR_LIMITS, writePullRequestContext } from "./workdir.js";

let dir: string;

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("pull request workdir", () => {
  it("copies the diff and readable head files, and skips the rest", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ask-workdir-"));

    const contents = new Map([
      ["src/a.ts", "export const a = 1;\n"],
      ["big.txt", "x".repeat(50)],
      ["../escape.txt", "nope"],
    ]);

    await writePullRequestContext(
      dir,
      "review-1",
      async (route, schema) => {
        if (route === "/review-1/diff?patch=true")
          return schema.parse([
            {
              path: "src/a.ts",
              status: "added",
              additions: 1,
              deletions: 0,
              patch: "+a",
            },
            { path: "big.txt", status: "modified", additions: 1, deletions: 1 },
            {
              path: "img.png",
              status: "added",
              additions: 0,
              deletions: 0,
              binary: true,
            },
            { path: "gone.ts", status: "deleted", additions: 0, deletions: 3 },
            {
              path: "../escape.txt",
              status: "added",
              additions: 1,
              deletions: 0,
            },
          ]);
        const file = new URL(route, "http://x").searchParams.get("file")!;

        return schema.parse({ text: contents.get(file) });
      },
      { ...WORKDIR_LIMITS, fileBytes: 40 },
    );

    expect(readFileSync(path.join(dir, "PR_DIFF.patch"), "utf8")).toBe("+a");
    expect(readFileSync(path.join(dir, "head/src/a.ts"), "utf8")).toBe(
      contents.get("src/a.ts"),
    );
    expect(existsSync(path.join(dir, "head/big.txt"))).toBe(false);
    expect(existsSync(path.join(dir, "escape.txt"))).toBe(false);

    const listing = readFileSync(path.join(dir, "CHANGED_FILES.txt"), "utf8");

    expect(listing).toContain("big.txt [too large, not copied]");
    expect(listing).toContain("img.png [binary, not copied]");
    expect(listing).toContain("deleted\t+0 -3\tgone.ts\n");
  });
});
