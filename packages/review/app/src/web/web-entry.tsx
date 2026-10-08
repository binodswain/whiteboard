import type { ReviewApiSummary } from "@dev.fast/review-protocol";
import { ReviewApiClient } from "@dev.fast/review-protocol";
import { mountReviewCanvas } from "../desktop-entry";
import { createWebBridge } from "./web-bridge";

const root = document.querySelector<HTMLElement>("#root");
if (!root) throw new Error("Missing #root element.");
const bridge = createWebBridge();
const client = new ReviewApiClient({ serverUrl: bridge.config.serverUrl, token: bridge.config.token }, bridge.request);
let handle: ReturnType<typeof mountReviewCanvas>;

function openReview(reviewId: string, version?: number) {
  history.pushState(null, "", `/r/${encodeURIComponent(reviewId)}`);
  const reviewBridge = createWebBridge(reviewId);
  handle.update({ kind: "api", reviewId, version, bridge: reviewBridge });
}

async function showHome() {
  let reviews: ReviewApiSummary[] = [];
  try { reviews = await client.read<ReviewApiSummary[]>(""); } catch (error) { console.error("Could not load review catalog", error); }
  handle.update({ kind: "home", reviews, openReview, openTutorial() {} });
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const catalog of client.watch<ReviewApiSummary[]>(null, controller.signal)) {
        reviews = catalog;
        handle.update({ kind: "home", reviews, openReview, openTutorial() {} });
      }
    } catch (error) { if (!controller.signal.aborted) console.error("Review catalog watch disconnected", error); }
  })();
  window.addEventListener("popstate", () => {
    if (location.pathname === "/") { controller.abort(); void showHome(); }
    else { const id = decodeURIComponent(location.pathname.split("/")[2] ?? ""); openReview(id); }
  }, { once: true });
}

handle = mountReviewCanvas(root, { kind: "loading" });
if (location.pathname.startsWith("/r/")) openReview(decodeURIComponent(location.pathname.slice(3)));
else void showHome();
