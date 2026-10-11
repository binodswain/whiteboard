import { layer } from "@canvas/scale.stylex";
import { ToastCard } from "@canvas/toast";
import * as stylex from "@stylexjs/stylex";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { createWebThemeHost } from "./web-theme-host";

type WebToast = { id: number; kind: "success" | "error"; text: string };

const SUCCESS_MS = 4000;

let toasts: WebToast[] = [];

let nextId = 0;

let mounted: { host: HTMLElement } | undefined;

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function remove(id: number) {
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

function WebToastStack() {
  const current = useSyncExternalStore(subscribe, () => toasts);

  return (
    <div data-web-toasts="" {...stylex.props(styles.stack)}>
      {current.map((toast) => (
        <ToastCard
          key={toast.id}
          kind={toast.kind}
          onDismiss={
            toast.kind === "error" ? () => remove(toast.id) : undefined
          }
          xstyle={styles.item}
        >
          {toast.text}
        </ToastCard>
      ))}
    </div>
  );
}

function ensureMounted() {
  if (mounted?.host.isConnected) return;

  const host = createWebThemeHost(document, { displayContents: true });

  document.body.append(host);
  createRoot(host).render(<WebToastStack />);
  mounted = { host };
}

/** The bridge's `notify` in a plain browser tab: toasts stack in one column. */
export function showWebToast(kind: WebToast["kind"], text: string): void {
  ensureMounted();

  const id = nextId++;

  toasts = [...toasts, { id, kind, text }];
  emit();

  // A failure may need a follow-up, so it stays until dismissed.
  if (kind === "success") setTimeout(() => remove(id), SUCCESS_MS);
}

const styles = stylex.create({
  stack: {
    position: "fixed",
    insetInlineEnd: "18px",
    insetBlockEnd: "18px",
    zIndex: layer.toast,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "8px",
    pointerEvents: "none",
  },
  item: {
    pointerEvents: "auto",
  },
});
