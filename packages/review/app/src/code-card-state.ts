import { type RefObject, useEffect, useRef } from "react";

import { useReviewSession } from "./host/review-session";
import {
  readReviewUiState,
  reviewUiStateKey,
  useReviewUiState,
  writeReviewUiState,
} from "./review-ui-state";

/** A compact code card's expansion state: whether source context is
 * revealed, or a standalone snippet is expanded past its preview. Keyed by
 * content + effective revision, so a stale key (different text, file, side,
 * pins or range) never reads another item's state — it just falls back to
 * the default, exactly as "Invalidate cached state when the content or
 * effective revision changes" asks for.
 *
 * Scoped to the review session (survives a reload, dies when the session
 * ends): "Store expansion ... for the lifetime of the open review
 * session." */
export function useCodeCardExpanded(
  key: string,
  fallback: boolean,
): [boolean, (next: boolean) => void] {
  const [expanded, setExpanded] = useReviewUiState<boolean>(key, fallback, {
    scope: "session",
    namespace: "code-card-expanded",
  });

  return [expanded, setExpanded];
}

/** Persists one code card's inner scroll position across remounts, for the
 * same key, in the same session. Best-effort: a missing ref or storage
 * failure silently does nothing. */
export function usePersistedCodeScroll(
  key: string | undefined,
  ref: RefObject<HTMLElement | null>,
): void {
  const session = useReviewSession();
  const frameRef = useRef(0);

  useEffect(() => {
    const element = ref.current;

    if (!key || !element) return;

    const storageKey = reviewUiStateKey(
      session.config,
      "session",
      "code-card-scroll",
      key,
    );

    const saved = readReviewUiState<number>("session", storageKey);

    if (saved) element.scrollTop = saved;

    const onScroll = () => {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(() => {
        writeReviewUiState("session", storageKey, element.scrollTop);
      });
    };

    element.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      cancelAnimationFrame(frameRef.current);
      element.removeEventListener("scroll", onScroll);
    };
  }, [key, session.config]);
}

/** A short, stable fingerprint for standalone snippet text: there is no
 * revision to key state on, so the text itself (plus language and starting
 * line) stands in for "content + effective revision". FNV-1a avoids
 * shipping another hashing dependency for a cache key that only needs to
 * be stable and collision-resistant in practice, not cryptographic. */
export function fingerprintText(text: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(36);
}
