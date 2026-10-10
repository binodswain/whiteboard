import { fontWeight } from "@canvas/scale.stylex";
import {
  type ShjLanguage,
  type ShjToken,
  tokenize,
} from "@speed-highlight/core";
import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useEffect, useState } from "react";

import { tokens } from "./tokens.stylex";

export type { ShjLanguage };

export interface HighlightedToken {
  text: string;
  token: ShjToken | undefined;
}

/** A trailing newline ends the last line rather than starting an empty one. */
export function countLines(code: string): number {
  const lines = code.split("\n");

  return lines.length > 1 && lines.at(-1) === ""
    ? lines.length - 1
    : lines.length;
}

export function normalizeMarkdownCodeLanguage(
  language: string,
): ShjLanguage | null {
  const normalized = language.trim().toLowerCase();

  switch (normalized) {
    case "asm":
    case "bash":
    case "bf":
    case "c":
    case "css":
    case "csv":
    case "diff":
    case "docker":
    case "git":
    case "go":
    case "html":
    case "http":
    case "ini":
    case "java":
    case "js":
    case "jsdoc":
    case "json":
    case "leanpub-md":
    case "log":
    case "lua":
    case "make":
    case "md":
    case "pl":
    case "plain":
    case "py":
    case "regex":
    case "rs":
    case "sql":
    case "todo":
    case "toml":
    case "ts":
    case "uri":
    case "xml":
    case "yaml":
      return normalized;
    case "javascript":
    case "jsx":
      return "js";
    case "typescript":
    case "tsx":
      return "ts";
    case "python":
      return "py";
    case "rust":
      return "rs";
    case "markdown":
    case "mdx":
      return "md";
    case "shell":
    case "sh":
    case "zsh":
      return "bash";
    case "yml":
      return "yaml";
    case "text":
      return "plain";
    default:
      return null;
  }
}

const LANGUAGE_BY_EXTENSION = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
  py: "py",
  rs: "rs",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cc: "c",
  cpp: "c",
  hpp: "c",
  css: "css",
  html: "html",
  htm: "html",
  json: "json",
  jsonc: "json",
  md: "md",
  mdx: "md",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  ini: "ini",
  diff: "diff",
  patch: "diff",
  lua: "lua",
  pl: "pl",
  dockerfile: "docker",
} satisfies Record<string, string>;

/** The fenced-markdown language a file's extension implies, for highlighting
 * a source excerpt that carries no authored language — a filename, not a
 * guess at which lines matter. */
export function languageFromFilename(path: string): string | null {
  const base = path.split("/").at(-1) ?? path;

  if (base.toLowerCase() === "dockerfile") return "docker";

  const extension = (
    base.includes(".") ? base.split(".").at(-1)! : ""
  ).toLowerCase();

  // SAFETY: Object.hasOwn just confirmed `extension` is one of this table's
  // own keys.
  return Object.hasOwn(LANGUAGE_BY_EXTENSION, extension)
    ? LANGUAGE_BY_EXTENSION[extension as keyof typeof LANGUAGE_BY_EXTENSION]
    : null;
}

/** Tokenizes `code` with speed-highlight; `null` while pending, on failure,
 * or when the language is unsupported (the caller falls back to plain text). */
export function useHighlightedTokens(
  code: string,
  normalizedLanguage: ShjLanguage | null,
): HighlightedToken[] | null {
  const [highlightedTokens, setHighlightedTokens] = useState<
    HighlightedToken[] | null
  >(null);

  useEffect(() => {
    let cancelled = false;

    if (!normalizedLanguage) {
      setHighlightedTokens(null);

      return;
    }

    const nextTokens: HighlightedToken[] = [];
    tokenize(code, normalizedLanguage, (text, token) => {
      nextTokens.push({ text, token });
    })
      .then(() => {
        if (!cancelled) setHighlightedTokens(nextTokens);
      })
      .catch(() => {
        if (!cancelled) setHighlightedTokens(null);
      });

    return () => {
      cancelled = true;
    };
  }, [code, normalizedLanguage]);

  return highlightedTokens;
}

/** Splits a flat, whole-block token stream into one token array per line, so
 * a per-line renderer (a gutter row, a dimmed context line) can lay out each
 * line independently while keeping token-level colors. */
export function splitHighlightedTokensByLine(
  tokens: readonly HighlightedToken[],
): HighlightedToken[][] {
  const lines: HighlightedToken[][] = [[]];

  for (const item of tokens) {
    const parts = item.text.split("\n");

    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);

      if (part.length > 0)
        lines.at(-1)!.push({ text: part, token: item.token });
    });
  }

  return lines;
}

/** Renders a flat, whole-block token stream (or the raw code, unhighlighted)
 * as `<code>` children; newlines inside token text render as line breaks
 * because the caller sets `white-space: pre`. */
export function renderHighlightedCode(
  code: string,
  normalizedLanguage: ShjLanguage | null,
  highlightedTokens: HighlightedToken[] | null,
): ReactNode {
  if (!normalizedLanguage || !highlightedTokens) return code;

  return highlightedTokens.map((item, index) =>
    item.token ? (
      <span {...stylex.props(syntaxByToken[item.token])} key={index}>
        {item.text}
      </span>
    ) : (
      item.text
    ),
  );
}

/** Renders one line's already-split token array as `<code>` children. */
export function renderHighlightedLine(
  lineTokens: readonly HighlightedToken[] | undefined,
  fallbackText: string,
): ReactNode {
  if (!lineTokens) return fallbackText || " ";

  if (lineTokens.length === 0) return " ";

  return lineTokens.map((item, index) =>
    item.token ? (
      <span {...stylex.props(syntaxByToken[item.token])} key={index}>
        {item.text}
      </span>
    ) : (
      item.text
    ),
  );
}

// Syntax tokens (@speed-highlight/core). The Whiteboard palette: ink at three
// strengths, the marker for keywords, two more blues for types and functions,
// one warm pencil for strings and one plum for numbers. Comments are quiet and
// italic. Diff green and red are reserved for the diff language. The editor
// themes carry the same values.
const syntaxStyles = stylex.create({
  kwd: { color: tokens.accent },
  type: { color: tokens.syntaxType },
  class: { color: tokens.syntaxType, fontWeight: fontWeight.medium },
  func: { color: tokens.syntaxFunction },
  section: { color: tokens.syntaxFunction, fontWeight: fontWeight.semibold },
  var: { color: tokens.ink },
  str: { color: tokens.syntaxString },
  num: { color: tokens.syntaxNumber },
  bool: { color: tokens.syntaxNumber, fontWeight: fontWeight.medium },
  cmnt: { color: tokens.syntaxComment, fontStyle: "italic" },
  oper: { color: tokens.syntaxOperator },
  insert: { color: tokens.syntaxInserted },
  deleted: { color: tokens.syntaxDeleted },
  err: {
    color: tokens.syntaxDeleted,
    textDecorationLine: "underline",
    textDecorationStyle: "wavy",
  },
});

export const syntaxByToken: Partial<Record<ShjToken, stylex.StyleXStyles>> = {
  ...syntaxStyles,
};
