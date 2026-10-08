import type { ReviewCanvasBridge, ReviewRuntimeConfig } from "@dev.fast/review-protocol";
import { reviewFetchUrl } from "../host/review-client";

const wasmUrl = new URL("../../../node_modules/@mr_mint/elkjs-libavoid/dist/libavoid.wasm", import.meta.url).href;

export function createWebBridge(reviewId = ""): ReviewCanvasBridge {
  const url = new URL(location.href);
  const key = "review-token";
  const token = url.hash.slice(1) || sessionStorage.getItem(key) || "";
  if (url.hash) {
    sessionStorage.setItem(key, token);
    history.replaceState(null, "", `${url.pathname}${url.search}`);
  }
  const config = { serverUrl: location.origin, reviewId, token, wasmUrl, appVersion: "web", theme: "system", host: "desktop" } as unknown as ReviewRuntimeConfig;
  const media = matchMedia("(prefers-color-scheme: dark)");
  const noOp = { dispose() {} };
  return {
    config,
    request: (requestUrl, init) => reviewFetchUrl(config, requestUrl, init),
    inlineEditors: { async find() { return { matchCount: 0 }; }, create() { throw new Error("Inline editors are unavailable in the browser review canvas."); } },
    diffView: { async files() { return []; }, create() { throw new Error("Diff editors are unavailable in the browser review canvas."); } },
    async post() { return { ok: false, error: "Editor actions are unavailable in the browser review canvas." }; },
    subscribe: () => noOp,
    currentTheme: () => media.matches ? "dark" : "light",
    onDidChangeTheme(listener) {
      const changed = () => listener(media.matches ? "dark" : "light");
      media.addEventListener("change", changed);
      return { dispose: () => media.removeEventListener("change", changed) };
    },
    currentDiffLayout: () => "split",
    async setDiffLayout() {},
    onDidChangeDiffLayout: () => noOp,
    notify({ kind, text }) {
      const node = document.createElement("div");
      node.textContent = text;
      node.setAttribute("role", kind === "error" ? "alert" : "status");
      document.body.append(node);
      setTimeout(() => node.remove(), 4000);
    },
    setupTooltip(target, text) {
      target.title = text;
      return { dispose: () => { target.removeAttribute("title"); } };
    },
    ready() {},
    reportDiagnostic(diagnostic) { console.error("Review canvas diagnostic", diagnostic); },
  };
}
