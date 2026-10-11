import { EmptyState } from "@canvas/ui/empty-state";
import * as stylex from "@stylexjs/stylex";
import {
  Component,
  type ContextType,
  type ErrorInfo,
  type ReactNode,
} from "react";

import { AuthoringActivityContext } from "./authoring-activity-context";
import { scopeLive } from "./authoring-cursor";
import { documentStyles } from "./document-styles";
import type { ReviewSession } from "./host/review-session";
import { captureClientError } from "./ui-telemetry";

interface ReviewDocumentBoundaryProps {
  session: ReviewSession;
  revision: string;
  onError: (revision: string, error: Error) => void;
  children: ReactNode;
}

interface ReviewDocumentBoundaryState {
  hasError: boolean;
  revision: string;
}

export class ReviewDocumentBoundary extends Component<
  ReviewDocumentBoundaryProps,
  ReviewDocumentBoundaryState
> {
  state: ReviewDocumentBoundaryState = {
    hasError: false,
    revision: this.props.revision,
  };
  static contextType = AuthoringActivityContext;
  declare context: ContextType<typeof AuthoringActivityContext>;
  private reportedRevision: string | undefined;

  static getDerivedStateFromError(): Pick<
    ReviewDocumentBoundaryState,
    "hasError"
  > {
    return { hasError: true };
  }

  static getDerivedStateFromProps(
    props: ReviewDocumentBoundaryProps,
    state: ReviewDocumentBoundaryState,
  ): ReviewDocumentBoundaryState | null {
    // New content gets a fresh render; the last failure was for the old revision.
    return props.revision === state.revision
      ? null
      : { hasError: false, revision: props.revision };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    if (this.reportedRevision === this.props.revision) return;
    this.reportedRevision = this.props.revision;
    captureClientError(this.props.session, "render", error);
    this.props.onError(this.props.revision, error);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      // The agent-writing copy needs independent evidence: a live document
      // lease. Without one the block is simply broken and waiting won't help.
      if (scopeLive(this.context, "document")) {
        return (
          <EmptyState
            variant="document"
            role="status"
            message="Your coding agent is writing the canvas now…"
          />
        );
      }

      return (
        <EmptyState
          variant="document"
          role="alert"
          title="This document could not be displayed"
          message={
            <>
              A block failed to render. Edit the review through the Whiteboard
              MCP tools or{" "}
              <code {...stylex.props(documentStyles.code)}>whiteboard api</code>{" "}
              to replace the failing block, then reload the page.
            </>
          }
        />
      );
    }

    return this.props.children;
  }
}
