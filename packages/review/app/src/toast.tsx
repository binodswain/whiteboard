import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { useOptionalReviewSession } from "./host/review-session";
import { appMarker } from "./markers.stylex";
import { elevation, fontSize, layer, radius } from "./scale.stylex";
import { shellStyles } from "./shell-styles";
import type { StyleArg } from "./stylex-props";
import { tokens } from "./tokens.stylex";
import { Button } from "./ui/button";

type ToastMessage = { kind: "success" | "error"; text: string };

export function useToast(durationMs = 6_000) {
  const session = useOptionalReviewSession();
  const [message, setMessage] = useState<ToastMessage | null>(null);

  const showToast = useCallback(
    (message: ToastMessage) => {
      if (session?.bridge.notify) session.bridge.notify(message);
      else setMessage(message);
    },
    [session],
  );

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(null), durationMs);

    return () => window.clearTimeout(timeout);
  }, [message, durationMs]);

  return {
    showToast,
    toast: message ? <Toast message={message} /> : null,
  };
}

function Toast({ message }: { message: ToastMessage }) {
  return (
    <ToastCard
      kind={message.kind}
      xstyle={[shellStyles.topbarItem, styles.floating]}
    >
      {message.text}
    </ToastCard>
  );
}

/**
 * One notification's box: the look every toast shares, in the canvas and in the
 * browser host that stacks them. The caller places it.
 */
export function ToastCard({
  kind,
  children,
  onDismiss,
  xstyle,
}: {
  kind: ToastMessage["kind"];
  children: ReactNode;
  /** A failure may need a follow-up, so it offers a way to close itself. */
  onDismiss?: () => void;
  xstyle?: StyleArg;
}) {
  return (
    <div
      {...stylex.props(styles.toast, styles[kind], xstyle)}
      role={kind === "error" && onDismiss ? "alert" : "status"}
    >
      <span>{children}</span>
      {onDismiss ? (
        <Button xstyle={styles.dismiss} variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      ) : null}
    </div>
  );
}

const inApp = () => stylex.when.ancestor(":is(*)", appMarker);

const styles = stylex.create({
  // Notification colors on purpose: it reads as the host's own toast.
  floating: {
    position: "fixed",
    zIndex: layer.toast,
    right: "18px",
    bottom: "18px",
  },
  toast: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    maxWidth: "380px",
    // Only the app root defines --chrome-border, and the border came from a
    // shorthand that drops out without it: a toast portaled outside the app
    // has none.
    borderWidth: { default: 0, [inApp()]: "1px" },
    borderStyle: { default: "none", [inApp()]: "solid" },
    borderRadius: radius.surface,
    padding: "10px 12px",
    backgroundColor: "var(--vscode-notifications-background, var(--tray))",
    boxShadow: elevation.popover,
    color: "var(--vscode-notifications-foreground, var(--ink))",
    font: `${fontSize.small}/1.4 ${tokens.fontMono}`,
  },
  dismiss: { marginInlineStart: "auto" },
  success: { borderColor: tokens.diffAdded },
  error: { borderColor: tokens.diffModified },
});
