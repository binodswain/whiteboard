import { readCachedTheme, resolveTheme } from "./theme-cache";
import { startWebCanvas } from "./web-app";

const root = document.querySelector<HTMLElement>("#root");

if (!root) throw new Error("The web canvas needs a #root element.");

// Match the page background to the saved theme before React mounts.
document.documentElement.dataset.theme = resolveTheme(readCachedTheme());

startWebCanvas(root);
