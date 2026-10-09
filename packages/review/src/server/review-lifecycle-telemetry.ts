import type { PostHogCaptureProperties } from "@review/posthog-capture-client";
import type { ReviewApiHooks } from "@review/review-api/http.js";
import type {
  ReviewSessionAgent,
  ReviewTelemetry,
} from "@review/review-telemetry";

/**
 * Review created, published and revoked, and agent authoring completed, as
 * server events. Authoring is complete at the first publish of a review an
 * agent created through `whiteboard api` or `whiteboard mcp`, timed from the review's
 * creation. Which reviews an agent created is known only to this process, so
 * a server restart between create and publish loses that one completion.
 * Sign-in reports its funnel, and a success calls `onLoggedIn`.
 */
export function reviewLifecycleTelemetry(
  telemetry: Pick<ReviewTelemetry, "captureEvent">,
  firstCreatedAt: (
    reviewId: string,
  ) => string | undefined | Promise<string | undefined>,
  onLoggedIn: () => Promise<void>,
  now: () => number = Date.now,
): ReviewApiHooks {
  const reported = new Set<string>();
  const authoring = new Map<string, ReviewSessionAgent | undefined>();

  const capture = (
    event: string,
    properties?: PostHogCaptureProperties,
    reviewUuid?: string,
  ) =>
    void telemetry.captureEvent(
      event,
      properties,
      reviewUuid ? { reviewUuid } : undefined,
    );

  return {
    onReviewCreated: ({ reviewId, kind, blocks, via, agentKind }) => {
      if (reported.has(reviewId)) return;
      reported.add(reviewId);

      if (via === "api" || via === "mcp") authoring.set(reviewId, agentKind);
      const properties: PostHogCaptureProperties = { kind, blocks, via };

      if (agentKind) properties.agent_kind = agentKind;
      capture("review_review_created", properties, reviewId);
    },
    sharing: {
      onPublished: ({ reviewId, version }) => {
        capture("review_review_published", { version }, reviewId);

        if (!authoring.has(reviewId)) return;
        const agentKind = authoring.get(reviewId);
        authoring.delete(reviewId);
        const publishedAt = now();

        const emit = (firstCreated: string | undefined) => {
          const createdAt = Date.parse(firstCreated ?? "");

          if (Number.isNaN(createdAt)) return;

          const properties: PostHogCaptureProperties = {
            duration_ms: Math.max(0, publishedAt - createdAt),
          };

          if (agentKind) properties.agent_kind = agentKind;
          capture("review_authoring_completed", properties, reviewId);
        };

        const first = firstCreatedAt(reviewId);

        if (first instanceof Promise) void first.then(emit);
        else emit(first);
      },
      onRevoked: () => capture("review_review_revoked"),
      onLogin: (outcome, reason) => {
        capture(`review_login_${outcome}`, reason ? { reason } : {});

        if (outcome === "succeeded") void onLoggedIn();
      },
    },
  };
}
