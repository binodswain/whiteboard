import type { ReviewTheme } from "@dev.fast/review-protocol";

export type ThemeChoice = "light" | "dark" | "system";

// Per-browser copy of the last theme choice. The server owns the setting;
// this only lets loading, error, setup and toast surfaces paint the right
// palette before (or without) a settings response.
const STORAGE_KEY = "whiteboard.theme";

export function readCachedTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);

    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

export function writeCachedTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Storage can be blocked; the server setting still applies.
  }
}

export function resolveTheme(choice: ThemeChoice): ReviewTheme {
  if (choice !== "system") return choice;

  return typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}
