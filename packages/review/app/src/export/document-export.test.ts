import { documentSchema } from "@review/review-api/document.js";
import type { Snapshot } from "@review/review-api/store.js";
import { describe, expect, it } from "vitest";

import {
  exportFilename,
  exportHtml,
  exportMarkdown,
} from "./document-export.js";

// ---------------------------------------------------------------------------
// Minimal snapshot factory
// ---------------------------------------------------------------------------

function snap(
  overrides: Partial<Snapshot> & { document?: Snapshot["document"] },
): Snapshot {
  return {
    reviewId: "r1",
    version: 1,
    title: "Test Review",
    createdAt: "2024-01-01T00:00:00Z",
    document: documentSchema.parse(overrides.document ?? []),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// exportFilename
// ---------------------------------------------------------------------------

describe("exportFilename", () => {
  it("slugifies title and appends extension", () => {
    expect(exportFilename(snap({ title: "My Review!" }), "md")).toBe(
      "my-review.md",
    );
    expect(exportFilename(snap({ title: "My Review!" }), "html")).toBe(
      "my-review.html",
    );
  });

  it("collapses runs of non-alphanumeric chars to a single hyphen", () => {
    expect(exportFilename(snap({ title: "A & B: the story" }), "md")).toBe(
      "a-b-the-story.md",
    );
  });

  it("trims leading and trailing hyphens", () => {
    expect(exportFilename(snap({ title: "---hello---" }), "md")).toBe(
      "hello.md",
    );
  });

  it("falls back to 'review' for titles that produce an empty slug", () => {
    expect(exportFilename(snap({ title: "!!!###" }), "md")).toBe("review.md");
  });

  it("truncates slug to 64 chars", () => {
    const longTitle = "a".repeat(80);
    expect(exportFilename(snap({ title: longTitle }), "md")).toBe(
      `${"a".repeat(64)}.md`,
    );
  });
});

// ---------------------------------------------------------------------------
// exportMarkdown — document structure
// ---------------------------------------------------------------------------

describe("exportMarkdown", () => {
  it("starts with the review title as an h1", () => {
    const md = exportMarkdown(snap({ title: "My Review" }));
    expect(md).toMatch(/^# My Review\n/);
  });

  it("passes markdown blocks through verbatim", () => {
    const md = exportMarkdown(
      snap({
        document: [
          { id: "m1", type: "markdown", markdown: "Hello **world**" },
        ],
      }),
    );

    expect(md).toContain("Hello **world**");
  });

  it("renders code as a fenced block with language", () => {
    const md = exportMarkdown(
      snap({
        document: [
          {
            id: "c1",
            type: "code",
            language: "ts",
            text: "const x = 1;",
          },
        ],
      }),
    );

    expect(md).toContain("```ts\nconst x = 1;\n```");
  });

  it("includes caption before a code block", () => {
    const md = exportMarkdown(
      snap({
        document: [
          {
            id: "c1",
            type: "code",
            language: "py",
            text: "pass",
            caption: "Empty function",
          },
        ],
      }),
    );

    expect(md).toContain("*Empty function*");
    expect(md.indexOf("*Empty function*")).toBeLessThan(md.indexOf("```py"));
  });

  it("renders section titles as ATX headings and recurses into children", () => {
    const md = exportMarkdown(
      snap({
        document: [
          {
            id: "s1",
            type: "section",
            title: "Overview",
            children: [
              { id: "m2", type: "markdown", markdown: "Some content." },
            ],
          },
        ],
      }),
    );

    expect(md).toContain("## Overview");
    expect(md).toContain("Some content.");
  });

  it("nests sections: outer ## inner ### (caps at h6)", () => {
    const md = exportMarkdown(
      snap({
        document: [
          {
            id: "s1",
            type: "section",
            title: "Outer",
            children: [
              {
                id: "s2",
                type: "section",
                title: "Inner",
                children: [],
              },
            ],
          },
        ],
      }),
    );

    expect(md).toContain("## Outer");
    expect(md).toContain("### Inner");
  });

  it("renders callout as a blockquote with tone label and child content", () => {
    const md = exportMarkdown(
      snap({
        document: [
          {
            id: "ca1",
            type: "callout",
            tone: "warning",
            children: [
              { id: "m3", type: "markdown", markdown: "Watch out!" },
            ],
          },
        ],
      }),
    );

    expect(md).toContain("> **⚠️ Warning**");
    expect(md).toMatch(/^> Watch out!/m);
  });

  it("uses the callout title when present", () => {
    const md = exportMarkdown(
      snap({
        document: [
          {
            id: "ca2",
            type: "callout",
            tone: "info",
            title: "Heads up",
            children: [],
          },
        ],
      }),
    );

    expect(md).toContain("> **Heads up**");
  });

  it("renders dividers as horizontal rules", () => {
    const md = exportMarkdown(
      snap({ document: [{ id: "d1", type: "divider" }] }),
    );

    expect(md).toContain("---");
  });

  it("renders code_peek as an italic reference note", () => {
    const md = exportMarkdown(
      snap({
        document: [
          {
            id: "cp1",
            type: "code_peek",
            source: "head/src/foo.ts#L1-L10",
          },
        ],
      }),
    );

    expect(md).toContain("head/src/foo.ts#L1-L10");
  });

  it("renders sequence as a mermaid fenced block with actors and arrows", () => {
    const md = exportMarkdown(
      snap({
        document: [
          {
            id: "seq1",
            type: "sequence",
            title: "Login",
            actors: { client: "Client", server: "Server" },
            steps: [
              {
                id: "st1",
                type: "step",
                from: "client",
                to: "server",
                label: "POST /login",
                style: "call",
                source: "head/src/auth.ts#L5",
              },
            ],
          },
        ],
      }),
    );

    expect(md).toContain("```mermaid");
    expect(md).toContain("sequenceDiagram");
    expect(md).toContain("participant client as Client");
    expect(md).toContain("client->>server: POST /login");
  });

  it("renders flow_diagram as a mermaid flowchart with nodes and edges", () => {
    const md = exportMarkdown(
      snap({
        document: [
          {
            id: "fd1",
            type: "flow_diagram",
            title: "Auth flow",
            nodes: [
              {
                id: "n1",
                type: "flow_node",
                key: "start",
                label: "Start",
                kind: "terminal",
                attachments: [],
              },
              {
                id: "n2",
                type: "flow_node",
                key: "check",
                label: "Token valid?",
                kind: "decision",
                attachments: [],
              },
            ],
            edges: [
              {
                id: "e1",
                type: "flow_edge",
                from: "start",
                to: "check",
                label: "next",
              },
            ],
          },
        ],
      }),
    );

    expect(md).toContain("flowchart LR");
    expect(md).toContain("n_start([Start])");
    expect(md).toContain("n_check{Token valid?}");
    expect(md).toContain("n_start-->|next|n_check");
  });

  it("renders image as an alt-text note", () => {
    const md = exportMarkdown(
      snap({
        document: [
          {
            id: "img1",
            type: "image",
            assetId: "asset-abc",
            alt: "Architecture diagram",
          },
        ],
      }),
    );

    expect(md).toContain("Architecture diagram");
  });

  it("renders trace_quote as a blockquote", () => {
    const md = exportMarkdown(
      snap({
        document: [
          {
            id: "tq1",
            type: "trace_quote",
            traceId: "trace-1",
            eventId: "ev-2",
            text: "Saved successfully",
          },
        ],
      }),
    );

    expect(md).toContain("trace-1");
    expect(md).toContain("ev-2");
    expect(md).toContain("Saved successfully");
  });

  it("outputs a trailing newline with no extra blank lines at the end", () => {
    const md = exportMarkdown(snap({ document: [] }));
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// exportHtml — document structure
// ---------------------------------------------------------------------------

describe("exportHtml", () => {
  it("returns a complete HTML document with doctype and charset", () => {
    const html = exportHtml(snap({ title: "My Review" }));
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<meta charset="UTF-8">');
  });

  it("includes the review title in <title> and <h1>", () => {
    const html = exportHtml(snap({ title: "My Review" }));
    expect(html).toContain("<title>My Review</title>");
    expect(html).toContain("<h1>My Review</h1>");
  });

  it("escapes HTML special chars in the title", () => {
    const html = exportHtml(snap({ title: "<Script & Friends>" }));
    expect(html).toContain("&lt;Script &amp; Friends&gt;");
    expect(html).not.toContain("<Script");
  });

  it("converts markdown blocks to HTML paragraphs", () => {
    const html = exportHtml(
      snap({
        document: [{ id: "m1", type: "markdown", markdown: "Hello **world**" }],
      }),
    );

    expect(html).toContain("<strong>world</strong>");
  });

  it("renders code blocks with escaped content", () => {
    const html = exportHtml(
      snap({
        document: [
          {
            id: "c1",
            type: "code",
            language: "ts",
            text: "const x = a < b ? 1 : 2;",
          },
        ],
      }),
    );

    expect(html).toContain("a &lt; b");
    expect(html).toContain('class="language-ts"');
  });

  it("wraps sections in a div with the heading level increasing by depth", () => {
    const html = exportHtml(
      snap({
        document: [
          {
            id: "s1",
            type: "section",
            title: "Overview",
            children: [
              {
                id: "s2",
                type: "section",
                title: "Details",
                children: [],
              },
            ],
          },
        ],
      }),
    );

    expect(html).toContain('class="section-block"');
    expect(html).toContain("<h2>Overview</h2>");
    expect(html).toContain("<h3>Details</h3>");
  });

  it("renders callouts with tone-specific CSS class and title", () => {
    const html = exportHtml(
      snap({
        document: [
          {
            id: "ca1",
            type: "callout",
            tone: "danger",
            title: "Critical",
            children: [],
          },
        ],
      }),
    );

    expect(html).toContain('class="callout callout-danger"');
    expect(html).toContain("Critical");
  });

  it("renders sequence as a table with actor and step info", () => {
    const html = exportHtml(
      snap({
        document: [
          {
            id: "seq1",
            type: "sequence",
            title: "Auth",
            actors: { a: "Alice", b: "Bob" },
            steps: [
              {
                id: "st1",
                type: "step",
                from: "a",
                to: "b",
                label: "hello",
                style: "call",
                source: "head/src/x.ts#L1",
              },
            ],
          },
        ],
      }),
    );

    expect(html).toContain("<h4>Auth</h4>");
    expect(html).toContain("<td>a</td>");
    expect(html).toContain("<td>hello</td>");
  });

  it("includes @media print styles", () => {
    const html = exportHtml(snap({ document: [] }));
    expect(html).toContain("@media print");
  });

  it("prevents XSS in markdown content — javascript: hrefs rewritten to #", () => {
    const html = exportHtml(
      snap({
        document: [
          {
            id: "m1",
            type: "markdown",
            markdown: "[click](javascript:alert(1))",
          },
        ],
      }),
    );

    expect(html).not.toContain("javascript:");
  });

  it("does not expose review-source: hrefs as clickable anchor href attributes", () => {
    const html = exportHtml(
      snap({
        document: [
          {
            id: "m1",
            type: "markdown",
            markdown:
              "[src](review-source:head/src/foo.ts#L1-L5)",
          },
        ],
      }),
    );

    // The link must not become an <a href="review-source:…"> — rendered as <span> instead.
    expect(html).not.toMatch(/href="review-source:/);
    // The label text "src" should still appear
    expect(html).toContain(">src<");
  });

  it("escapes raw HTML blocks in markdown instead of injecting them", () => {
    const html = exportHtml(
      snap({
        document: [
          {
            id: "m1",
            type: "markdown",
            markdown:
              '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">',
          },
        ],
      }),
    );

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain('onerror="alert(2)"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=");
  });

  it("renders GFM tables from markdown", () => {
    const html = exportHtml(
      snap({
        document: [
          {
            id: "m1",
            type: "markdown",
            markdown: "| A | B |\n|---|---|\n| 1 | 2 |",
          },
        ],
      }),
    );

    expect(html).toContain("<table>");
    expect(html).toContain("<th>");
  });

  it("renders dividers as <hr>", () => {
    const html = exportHtml(
      snap({ document: [{ id: "d1", type: "divider" }] }),
    );

    expect(html).toContain("<hr />");
  });
});
