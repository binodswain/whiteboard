import { type MarkdownNode, parseMarkdown } from "@review/markdown.js";
import type { Block } from "@review/review-api/blocks/index.js";
import type { Snapshot } from "@review/review-api/store.js";

// ---------------------------------------------------------------------------
// Filename
// ---------------------------------------------------------------------------

/**
 * Derive a safe filename from the review title plus the given extension.
 * Lowercases, collapses non-alphanumeric runs to hyphens, trims to 64 chars.
 */
export function exportFilename(snapshot: Snapshot, ext: "md" | "html"): string {
  const slug =
    snapshot.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "review";

  return `${slug}.${ext}`;
}

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

/**
 * Serialize a review snapshot to Markdown.
 *
 * - markdown blocks: pass through verbatim
 * - code: fenced with language
 * - sections: ATX headings (##…######), children indented one level deeper
 * - callouts: blockquote with bold title/tone label, children prefixed `> `
 * - dividers: `---`
 * - code_peek: italic reference note
 * - sequence diagrams: Mermaid `sequenceDiagram` fenced block
 * - flow diagrams: Mermaid `flowchart` fenced block
 * - call_stack_diff / images / trace quotes / specialist blocks: descriptive notes
 * - nested children rendered recursively
 */
export function exportMarkdown(snapshot: Snapshot): string {
  const out: string[] = [`# ${snapshot.title}`, ""];

  for (const block of snapshot.document) appendBlockMd(block, 1, out);

  while (out.length > 0 && out[out.length - 1] === "") out.pop();

  return out.join("\n") + "\n";
}

function appendBlockMd(block: Block, depth: number, out: string[]): void {
  switch (block.type) {
    case "markdown":
      out.push(block.markdown, "");
      break;

    case "code":
      if (block.caption) out.push(`*${mdEscape(block.caption)}*`, "");
      out.push(`\`\`\`${block.language}`, block.text, "```", "");
      break;

    case "section": {
      const hashes = "#".repeat(Math.min(depth + 1, 6));
      out.push(`${hashes} ${block.title}`, "");

      for (const child of block.children) appendBlockMd(child, depth + 1, out);
      break;
    }

    case "callout": {
      // Render children to a temporary buffer, then prefix every line with '> '
      const inner: string[] = [];

      for (const child of block.children) appendBlockMd(child, depth, inner);

      const toneLabel = {
        info: "ℹ️ Note",
        warning: "⚠️ Warning",
        danger: "🚨 Danger",
        success: "✅ Note",
      };

      const label = block.title
        ? `**${block.title}**`
        : `**${toneLabel[block.tone]}**`;

      out.push(`> ${label}`);

      for (const line of inner) out.push(line.length === 0 ? ">" : `> ${line}`);
      out.push("");
      break;
    }

    case "divider":
      out.push("---", "");
      break;

    case "code_peek":
      out.push(`> 📎 *Code reference: \`${block.source}\`*`, "");
      break;

    case "sequence": {
      out.push(`#### ${block.title}`, "", "```mermaid", "sequenceDiagram");

      for (const [key, label] of Object.entries(block.actors))
        out.push(`    participant ${key} as ${label}`);

      for (const step of block.steps) {
        const arrow =
          step.style === "return" ? "-->>"
          : step.style === "async" ? "->>+"
          : "->>";

        out.push(`    ${step.from}${arrow}${step.to}: ${step.label}`);
      }

      out.push("```", "");
      break;
    }

    case "flow_diagram": {
      const dir = block.direction === "down" ? "TD" : "LR";
      out.push(`#### ${block.title}`, "");

      if (block.description) out.push(block.description, "");
      out.push("```mermaid", `flowchart ${dir}`);

      for (const node of block.nodes) {
        const nodeMarkup =
          node.kind === "decision" ? `{${node.label}}`
          : node.kind === "terminal" ? `([${node.label}])`
          : `[${node.label}]`;

        out.push(`    ${node.key}${nodeMarkup}`);
      }

      for (const edge of block.edges) {
        const edgeLabel = edge.label ? `|${edge.label}|` : "";
        const arrow = edge.style === "dashed" ? "-.->": "-->";
        out.push(`    ${edge.from}${arrow}${edgeLabel}${edge.to}`);
      }

      out.push("```", "");
      break;
    }

    case "call_stack_diff":
      out.push(`#### ${block.title}`, "", "**Base call stack:**", "");

      for (const frame of block.base)
        out.push(`- \`${frame.label ?? frame.key ?? frame.source}\``);
      out.push("", "**Head call stack:**", "");

      for (const frame of block.head)
        out.push(`- \`${frame.label ?? frame.key ?? frame.source}\``);
      out.push("");
      break;

    case "database_lens":
      out.push("> 🗄️ *Database diagram — open in Whiteboard to view*", "");
      break;

    case "image":
      out.push(`> 🖼️ *Image: ${mdEscape(block.alt)}*`, "");
      break;

    case "trace_quote":
      out.push(
        `> *Trace \`${block.traceId}\`, event \`${block.eventId}\`:*`,
        `> ${block.text}`,
        "",
      );
      break;

    case "software_map":
      out.push("> 🗺️ *Software map — open in Whiteboard to view*", "");
      break;

    case "tutorial":
      break;

    default: {
      // Exhaustiveness guard — future block types degrade gracefully. The
      // switch above is exhaustive over Block, so TypeScript narrows block
      // to never here.
      const _: never = block;

      // SAFETY: the narrowing to never only reflects the known Block union;
      // the original value still carries whatever `type` string an
      // unrecognized future block variant sends, which we want to report.
      out.push(`> *[Unsupported block: ${(block as Block).type}]*`, "");
    }
  }
}

/**
 * Escape Markdown special characters in literal text values (titles, captions, alt text).
 * Three or more call sites across the export render functions need lockstep escaping.
 */
function mdEscape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// HTML export
// ---------------------------------------------------------------------------

/**
 * Serialize a review snapshot to a single self-contained HTML document.
 *
 * Markdown blocks are converted via an mdast walker (no external HTML library
 * required — only the `@review/markdown` module already used by the app).
 * The document includes inline CSS and `@media print` styles so it can be
 * saved as PDF via the browser's Print → Save as PDF.
 */
export function exportHtml(snapshot: Snapshot): string {
  const titleEsc = htmlEscape(snapshot.title);

  const bodyHtml = snapshot.document
    .map((b) => renderBlockHtml(b, 1))
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${titleEsc}</title>
<style>
  :root {
    --text: #1a1a1a;
    --bg: #ffffff;
    --muted: #6b7280;
    --border: #e5e7eb;
    --code-bg: #f3f4f6;
    --callout-info: #dbeafe;
    --callout-warning: #fef3c7;
    --callout-danger: #fee2e2;
    --callout-success: #d1fae5;
    --callout-info-border: #3b82f6;
    --callout-warning-border: #f59e0b;
    --callout-danger-border: #ef4444;
    --callout-success-border: #10b981;
  }
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 16px;
    line-height: 1.6;
    color: var(--text);
    background: var(--bg);
    max-width: 860px;
    margin: 0 auto;
    padding: 2rem 1.5rem;
  }
  h1 { font-size: 2em; margin: 0 0 0.5em; }
  h2 { font-size: 1.5em; margin: 1.5em 0 0.5em; border-bottom: 1px solid var(--border); padding-bottom: 0.25em; }
  h3 { font-size: 1.25em; margin: 1.25em 0 0.4em; }
  h4 { font-size: 1.1em; margin: 1em 0 0.35em; }
  h5, h6 { font-size: 1em; margin: 0.75em 0 0.3em; }
  p { margin: 0 0 1em; }
  a { color: #2563eb; }
  pre {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1rem;
    overflow-x: auto;
    margin: 0 0 1em;
    font-size: 0.875em;
  }
  code {
    background: var(--code-bg);
    border-radius: 3px;
    padding: 0.15em 0.35em;
    font-size: 0.9em;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  }
  pre code { background: none; padding: 0; border-radius: 0; font-size: inherit; }
  blockquote {
    border-left: 4px solid var(--border);
    margin: 0 0 1em;
    padding: 0.25em 0 0.25em 1em;
    color: var(--muted);
  }
  table { border-collapse: collapse; width: 100%; margin: 0 0 1em; }
  th, td { border: 1px solid var(--border); padding: 0.5em 0.75em; text-align: left; }
  th { background: var(--code-bg); font-weight: 600; }
  hr { border: none; border-top: 1px solid var(--border); margin: 1.5em 0; }
  img { max-width: 100%; height: auto; }
  ul, ol { margin: 0 0 1em; padding-left: 1.5em; }
  li { margin: 0.2em 0; }
  .callout {
    border-radius: 6px;
    border-left-width: 4px;
    border-left-style: solid;
    padding: 0.75rem 1rem;
    margin: 0 0 1em;
  }
  .callout-title { font-weight: 600; margin: 0 0 0.5em; }
  .callout-info    { background: var(--callout-info);    border-color: var(--callout-info-border); }
  .callout-warning { background: var(--callout-warning); border-color: var(--callout-warning-border); }
  .callout-danger  { background: var(--callout-danger);  border-color: var(--callout-danger-border); }
  .callout-success { background: var(--callout-success); border-color: var(--callout-success-border); }
  .diagram-note {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.75rem 1rem;
    margin: 0 0 1em;
    color: var(--muted);
    font-style: italic;
  }
  .section-block { margin: 0 0 1.5em; }
  @media print {
    body { max-width: none; padding: 0; font-size: 12pt; }
    a { color: inherit; text-decoration: none; }
    a[href]::after { content: " (" attr(href) ")"; font-size: 0.8em; color: var(--muted); }
    a[href^="review-source:"]::after { content: ""; }
    pre { white-space: pre-wrap; word-break: break-all; }
    h1, h2, h3, h4 { page-break-after: avoid; }
    .callout, pre, table { page-break-inside: avoid; }
    @page { margin: 2cm; }
  }
</style>
</head>
<body>
<h1>${titleEsc}</h1>
${bodyHtml}
</body>
</html>`;
}

function renderBlockHtml(block: Block, headingLevel: number): string {
  switch (block.type) {
    case "markdown":
      return markdownToHtml(block.markdown);

    case "code": {
      const caption = block.caption
        ? `<p><em>${htmlEscape(block.caption)}</em></p>\n`
        : "";

      return `${caption}<pre><code class="language-${htmlEscape(block.language)}">${htmlEscape(block.text)}</code></pre>\n`;
    }

    case "section": {
      const level = Math.min(headingLevel + 1, 6);

      const inner = block.children
        .map((c) => renderBlockHtml(c, headingLevel + 1))
        .join("\n");

      return `<div class="section-block">\n<h${level}>${htmlEscape(block.title)}</h${level}>\n${inner}</div>\n`;
    }

    case "callout": {
      const toneLabel = {
        info: "ℹ️ Note",
        warning: "⚠️ Warning",
        danger: "🚨 Danger",
        success: "✅ Note",
      };

      const titleHtml = block.title
        ? `<div class="callout-title">${htmlEscape(block.title)}</div>\n`
        : `<div class="callout-title">${toneLabel[block.tone]}</div>\n`;

      const inner = block.children
        .map((c) => renderBlockHtml(c, headingLevel))
        .join("\n");

      return `<div class="callout callout-${block.tone}">\n${titleHtml}${inner}</div>\n`;
    }

    case "divider":
      return `<hr />\n`;

    case "code_peek":
      return `<p><em>📎 Code reference: <code>${htmlEscape(block.source)}</code></em></p>\n`;

    case "sequence": {
      const actorList = Object.entries(block.actors)
        .map(([k, v]) => `${htmlEscape(k)}: ${htmlEscape(v)}`)
        .join(", ");

      const stepRows = block.steps
        .map(
          (s) =>
            `<tr><td>${htmlEscape(s.from)}</td><td>→</td><td>${htmlEscape(s.to)}</td><td>${htmlEscape(s.label)}</td></tr>`,
        )
        .join("\n");

      return `<h4>${htmlEscape(block.title)}</h4>\n<p><em>Actors: ${actorList}</em></p>\n<table>\n<thead><tr><th>From</th><th></th><th>To</th><th>Label</th></tr></thead>\n<tbody>\n${stepRows}\n</tbody>\n</table>\n`;
    }

    case "flow_diagram": {
      const desc = block.description
        ? `<p>${htmlEscape(block.description)}</p>\n`
        : "";

      const nodeRows = block.nodes
        .map(
          (n) =>
            `<tr><td>${htmlEscape(n.key)}</td><td>${htmlEscape(n.label)}</td><td>${htmlEscape(n.kind ?? "process")}</td></tr>`,
        )
        .join("\n");

      const edgeSection =
        block.edges.length === 0
          ? ""
          : `<table>\n<thead><tr><th>From</th><th></th><th>To</th><th>Label</th></tr></thead>\n<tbody>\n${block.edges
              .map(
                (e) =>
                  `<tr><td>${htmlEscape(e.from)}</td><td>→</td><td>${htmlEscape(e.to)}</td><td>${htmlEscape(e.label ?? "")}</td></tr>`,
              )
              .join("\n")}\n</tbody>\n</table>\n`;

      return `<h4>${htmlEscape(block.title)}</h4>\n${desc}<div class="diagram-note"><em>Flow diagram — open in Whiteboard to view interactively.</em></div>\n<table>\n<thead><tr><th>Key</th><th>Label</th><th>Kind</th></tr></thead>\n<tbody>\n${nodeRows}\n</tbody>\n</table>\n${edgeSection}`;
    }

    case "call_stack_diff": {
      const frameRows = (frames: typeof block.base) =>
        frames
          .map(
            (f) =>
              `<tr><td><code>${htmlEscape(f.label ?? f.key ?? "")}</code></td><td><code>${htmlEscape(f.source)}</code></td></tr>`,
          )
          .join("\n");

      return `<h4>${htmlEscape(block.title)}</h4>\n<p><strong>Base:</strong></p>\n<table><thead><tr><th>Label</th><th>Source</th></tr></thead><tbody>\n${frameRows(block.base)}\n</tbody></table>\n<p><strong>Head:</strong></p>\n<table><thead><tr><th>Label</th><th>Source</th></tr></thead><tbody>\n${frameRows(block.head)}\n</tbody></table>\n`;
    }

    case "database_lens":
      return `<div class="diagram-note"><em>🗄️ Database diagram — open in Whiteboard to view.</em></div>\n`;

    case "image":
      return `<div class="diagram-note"><em>🖼️ Image: ${htmlEscape(block.alt)}</em></div>\n`;

    case "trace_quote":
      return `<blockquote><p><em>Trace <code>${htmlEscape(block.traceId)}</code>, event <code>${htmlEscape(block.eventId)}</code>:</em></p><p>${htmlEscape(block.text)}</p></blockquote>\n`;

    case "software_map":
      return `<div class="diagram-note"><em>🗺️ Software map — open in Whiteboard to view.</em></div>\n`;

    case "tutorial":
      return "";

    default: {
      // The switch above is exhaustive over Block, so TypeScript narrows
      // block to never here.
      const _: never = block;

      // SAFETY: the narrowing to never only reflects the known Block union;
      // the original value still carries whatever `type` string an
      // unrecognized future block variant sends, which we want to report.
      return `<p><em>[Unsupported block: ${htmlEscape((block as Block).type)}]</em></p>\n`;
    }
  }
}

// ---------------------------------------------------------------------------
// Markdown → HTML via mdast walker
// ---------------------------------------------------------------------------

/**
 * Convert a Markdown string to an HTML fragment via the mdast AST from
 * `@review/markdown` (already used by the app; no new deps).
 * Handles GFM (tables, strikethrough, task lists) and math delimiters.
 */
function markdownToHtml(source: string): string {
  return nodeToHtml(parseMarkdown(source));
}

function nodeToHtml(node: MarkdownNode): string {
  // Inner helper: render all children and join — called at 10+ case branches.
  const children = () => (node.children ?? []).map(nodeToHtml).join("");

  switch (node.type) {
    case "root":
      return children();
    case "paragraph":
      return `<p>${children()}</p>\n`;
    case "heading": {
      const level = Math.min(Math.max(node.depth ?? 1, 1), 6);

      return `<h${level}>${children()}</h${level}>\n`;
    }

    case "text":
      return htmlEscape(node.value ?? "");
    case "emphasis":
      return `<em>${children()}</em>`;
    case "strong":
      return `<strong>${children()}</strong>`;
    case "delete":
      return `<del>${children()}</del>`;
    case "inlineCode":
      return `<code>${htmlEscape(node.value ?? "")}</code>`;
    case "code":
      return `<pre><code${node.lang ? ` class="language-${htmlEscape(node.lang)}"` : ""}>${htmlEscape(node.value ?? "")}</code></pre>\n`;
    case "blockquote":
      return `<blockquote>\n${children()}</blockquote>\n`;
    case "list": {
      const tag = node.ordered ? "ol" : "ul";

      const start =
        node.ordered && node.start != null && node.start !== 1
          ? ` start="${node.start}"`
          : "";

      return `<${tag}${start}>\n${children()}</${tag}>\n`;
    }

    case "listItem": {
      const checkbox =
        node.checked === true ? `<input type="checkbox" checked disabled> `
        : node.checked === false ? `<input type="checkbox" disabled> `
        : "";

      return `<li>${checkbox}${children()}</li>\n`;
    }

    case "link": {
      // review-source: links are internal opaque anchors — render as a plain span
      if (node.url?.startsWith("review-source:")) return `<span>${children()}</span>`;
      const href = safeHref(node.url ?? "");
      const title = node.title ? ` title="${htmlEscape(node.title)}"` : "";

      return `<a href="${htmlEscape(href)}"${title}>${children()}</a>`;
    }

    case "image": {
      const src = safeHref(node.url ?? "");
      const title = node.title ? ` title="${htmlEscape(node.title)}"` : "";

      return `<img src="${htmlEscape(src)}" alt="${htmlEscape(node.alt ?? "")}"${title} />\n`;
    }

    case "html":
      // Raw markdown HTML renders as escaped text in the app
      // (agent-markdown.tsx returns node.value as a React string), so the
      // export must escape it too — a raw pass-through would let a markdown
      // block inject <script>/<img onerror> into the exported document.
      return htmlEscape(node.value ?? "");
    case "thematicBreak":
      return `<hr />\n`;
    case "break":
      return `<br />\n`;
    case "table": {
      const [head, ...bodyRows] = node.children ?? [];

      // Whitelist mdast alignment to the three valid text-align values — a
      // nonstandard string would otherwise land inside a style attribute.
      const align = (node.align ?? []).map((a) =>
        a === "left" || a === "right" || a === "center" ? ` text-align:${a};` : "",
      );

      const thCells = (head?.children ?? [])
        .map(
          (cell, i) =>
            `<th${align[i] ? ` style="${align[i]}"` : ""}>${nodeToHtml(cell)}</th>`,
        )
        .join("");

      const tbodyRows = bodyRows
        .map(
          (row) =>
            `<tr>${(row.children ?? [])
              .map(
                (cell, i) =>
                  `<td${align[i] ? ` style="${align[i]}"` : ""}>${nodeToHtml(cell)}</td>`,
              )
              .join("")}</tr>\n`,
        )
        .join("");

      return `<table>\n<thead><tr>${thCells}</tr></thead>\n<tbody>\n${tbodyRows}</tbody>\n</table>\n`;
    }

    case "tableRow":
    case "tableCell":
      return children();
    case "math":
      return `<pre class="math">${htmlEscape(node.value ?? "")}</pre>\n`;
    case "inlineMath":
      return `<code class="math-inline">${htmlEscape(node.value ?? "")}</code>`;
    case "definition":
    case "linkReference":
    case "imageReference":
      // parseMarkdown resolves references to link/image nodes; these shouldn't appear
      return children();
    default:
      return children();
  }
}

/**
 * Escape HTML special characters in text content and attribute values.
 * Security-critical: called at every text boundary in the HTML serializer —
 * needs lockstep behavior across all 20+ call sites.
 */
function htmlEscape(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Allow only https/http/mailto/# hrefs; rewrite anything else (e.g. javascript:) to '#'.
 * Called for both link and image sources — two sites need the same security gate.
 */
function safeHref(href: string): string {
  if (
    href.startsWith("https://") ||
    href.startsWith("http://") ||
    href.startsWith("mailto:") ||
    href.startsWith("#")
  )
    return href;

  return "#";
}

