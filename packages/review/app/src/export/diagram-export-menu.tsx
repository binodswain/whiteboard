import { copyText } from "@canvas/copy-text";
import { diagramStyles } from "@canvas/diagram-styles";
import { fontSize } from "@canvas/scale.stylex";
import { withClass } from "@canvas/stylex-props";
import { useToast } from "@canvas/toast";
import { menuStyles } from "@canvas/ui/menu";
import { surfaceStyles } from "@canvas/ui/surface";
import { useAnchoredPopover } from "@canvas/use-anchored-popover";
import { useDismissOnOutside } from "@canvas/use-dismiss-on-outside";
import { useMenuKeyboard } from "@canvas/use-menu-keyboard";
import * as stylex from "@stylexjs/stylex";
import { type ReactElement, useRef, useState } from "react";

import {
  type C4ExportInput,
  type FlowExportInput,
  type SequenceExportInput,
  c4ToDrawio,
  c4ToExcalidraw,
  c4ToMermaid,
  c4ToXmind,
  diagramExportFilename,
  flowToDrawio,
  flowToExcalidraw,
  flowToMermaid,
  flowToXmind,
  sequenceToDrawio,
  sequenceToExcalidraw,
  sequenceToMermaid,
  sequenceToXmind,
} from "./diagram-export";
import {
  type DiagramRasterOptions,
  renderDiagramPng,
} from "./diagram-raster-export";

export type DiagramExportSource =
  | ({ kind: "sequence" } & SequenceExportInput)
  | ({ kind: "flow" } & FlowExportInput)
  | ({ kind: "c4" } & C4ExportInput);

const ITEMS = [
  { id: "copy-mermaid", label: "Copy Mermaid" },
  { id: "download-mermaid", label: "Download Mermaid" },
  { id: "download-excalidraw", label: "Download Excalidraw" },
  { id: "download-drawio", label: "Download draw.io" },
  { id: "download-xmind", label: "Download XMind" },
] as const;

type RasterAction = "copy" | "download";

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function download(content: string, mimeType: string, filename: string) {
  triggerDownload(new Blob([content], { type: mimeType }), filename);
}

function downloadBytes(bytes: Uint8Array, mimeType: string, filename: string) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  triggerDownload(new Blob([copy], { type: mimeType }), filename);
}

function diagramMermaid(source: DiagramExportSource): string {
  switch (source.kind) {
    case "sequence":
      return sequenceToMermaid(source);
    case "flow":
      return flowToMermaid(source);
    case "c4":
      return c4ToMermaid(source);
  }
}

async function diagramExcalidraw(source: DiagramExportSource): Promise<string> {
  switch (source.kind) {
    case "sequence":
      return sequenceToExcalidraw(source);
    case "flow":
      return flowToExcalidraw(source);
    case "c4":
      return c4ToExcalidraw(source);
  }
}

async function diagramDrawio(source: DiagramExportSource): Promise<string> {
  switch (source.kind) {
    case "sequence":
      return sequenceToDrawio(source);
    case "flow":
      return flowToDrawio(source);
    case "c4":
      return c4ToDrawio(source);
  }
}

function diagramXmind(source: DiagramExportSource): Uint8Array {
  switch (source.kind) {
    case "sequence":
      return sequenceToXmind(source);
    case "flow":
      return flowToXmind(source);
    case "c4":
      return c4ToXmind(source);
  }
}

/** Runs one export and returns what the reader should be told; throws a
 * message that says what to do next when it cannot finish. */
async function exportDiagram(
  source: DiagramExportSource,
  id: (typeof ITEMS)[number]["id"],
): Promise<string> {
  const name = (ext: string) => diagramExportFilename(source.title, ext);

  if (id === "copy-mermaid") {
    if (!(await copyText(diagramMermaid(source))))
      throw new Error(
        "Clipboard access was blocked. Use Download Mermaid instead.",
      );

    return "Copied Mermaid to the clipboard.";
  }

  if (id === "download-mermaid") {
    const filename = name("mmd");

    download(diagramMermaid(source), "text/plain", filename);

    return `Downloaded ${filename}.`;
  }

  if (id === "download-excalidraw") {
    const filename = name("excalidraw");

    download(await diagramExcalidraw(source), "application/json", filename);

    return `Downloaded ${filename}.`;
  }

  if (id === "download-drawio") {
    const filename = name("drawio");

    download(await diagramDrawio(source), "application/xml", filename);

    return `Downloaded ${filename}.`;
  }

  const filename = name("xmind");

  downloadBytes(
    diagramXmind(source),
    "application/vnd.xmind.workbook",
    filename,
  );

  return `Downloaded ${filename}.`;
}

async function exportPng(
  source: DiagramExportSource,
  figure: HTMLElement,
  action: RasterAction,
  options: DiagramRasterOptions,
): Promise<string> {
  const body = figure.querySelector<HTMLElement>("[data-diagram-export-body]");

  if (!body)
    throw new Error(
      "The diagram image isn't ready. Wait for it to finish drawing, then try again.",
    );

  const blob = await renderDiagramPng(body, options).catch((cause: unknown) => {
    throw new Error(
      `Could not render the PNG${cause instanceof Error ? ` (${cause.message})` : ""}. Try again.`,
    );
  });

  if (
    action === "copy" &&
    navigator.clipboard?.write &&
    "ClipboardItem" in window
  ) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);

      return "Copied the PNG to the clipboard.";
    } catch {
      // Clipboard image support varies by browser and permission state.
    }
  }

  const filename = diagramExportFilename(source.title, "png");

  triggerDownload(blob, filename);

  return action === "copy"
    ? `The clipboard couldn't take an image, so ${filename} was downloaded instead.`
    : `Downloaded ${filename}.`;
}

export function DiagramExportMenu({
  source,
}: {
  source: DiagramExportSource;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [rasterAction, setRasterAction] = useState<RasterAction | null>(null);
  const [theme, setTheme] = useState<DiagramRasterOptions["theme"]>("dark");
  const [border, setBorder] = useState<DiagramRasterOptions["border"]>("frame");
  const container = useRef<HTMLDivElement>(null);
  const { showToast, toast } = useToast();
  const menu = useAnchoredPopover(open, container);

  const { onKeyDown, restoreFocus } = useMenuKeyboard({
    open,
    container,
    menu,
    close: () => {
      setOpen(false);
      setRasterAction(null);
    },
    view: rasterAction ?? "items",
  });

  const report = (task: Promise<string>) =>
    task.then(
      (text) => showToast({ kind: "success", text }),
      (cause: unknown) =>
        showToast({
          kind: "error",
          text:
            cause instanceof Error
              ? cause.message
              : "The export failed. Try again.",
        }),
    );

  useDismissOnOutside(container, open, (nextOpen) => {
    setOpen(nextOpen);
    setRasterAction(null);
  });

  return (
    <div ref={container} {...stylex.props(styles.menu)}>
      <button
        type="button"
        {...withClass("diagram-export-button", diagramStyles.control)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Export diagram"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setTheme(
            container.current?.closest(".review-app--theme-light")
              ? "light"
              : "dark",
          );
          setOpen((current) => !current);
        }}
      >
        Export
      </button>
      {open && (
        <div
          ref={menu}
          popover="manual"
          role="menu"
          aria-label="Export diagram"
          tabIndex={-1}
          onKeyDown={onKeyDown}
          {...stylex.props(
            surfaceStyles.popover,
            menuStyles.popover,
            menuStyles.end,
            styles.list,
          )}
        >
          {rasterAction ? (
            <div
              {...stylex.props(styles.options)}
              role="dialog"
              aria-label="PNG export options"
            >
              <label>
                Theme
                <select
                  value={theme}
                  onChange={(event) => {
                    const value = event.currentTarget.value;

                    if (value === "light" || value === "dark") setTheme(value);
                  }}
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
              <label>
                Border
                <select
                  value={border}
                  onChange={(event) => {
                    const value = event.currentTarget.value;

                    if (
                      value === "none" ||
                      value === "frame" ||
                      value === "rounded"
                    )
                      setBorder(value);
                  }}
                >
                  <option value="none">None</option>
                  <option value="frame">Padded frame</option>
                  <option value="rounded">Rounded border</option>
                </select>
              </label>
              <button
                type="button"
                {...stylex.props(menuStyles.item)}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const figure = container.current?.closest("figure");

                  if (!figure) return;

                  setOpen(false);
                  setRasterAction(null);
                  restoreFocus();
                  void report(
                    exportPng(source, figure, rasterAction, { theme, border }),
                  );
                }}
              >
                {rasterAction === "copy" ? "Copy PNG" : "Download PNG"}
              </button>
              <button
                type="button"
                {...stylex.props(menuStyles.item)}
                onClick={() => setRasterAction(null)}
              >
                Back to exports
              </button>
            </div>
          ) : (
            <>
              {ITEMS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  {...stylex.props(menuStyles.item)}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpen(false);
                    restoreFocus();
                    void report(exportDiagram(source, item.id));
                  }}
                >
                  {item.label}
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                {...stylex.props(menuStyles.item)}
                onClick={() => setRasterAction("copy")}
              >
                Copy PNG…
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                {...stylex.props(menuStyles.item)}
                onClick={() => setRasterAction("download")}
              >
                Download PNG…
              </button>
            </>
          )}
        </div>
      )}
      {toast}
    </div>
  );
}

const styles = stylex.create({
  menu: {
    position: "relative",
  },
  list: {
    width: "220px",
  },
  options: {
    display: "grid",
    gap: "8px",
    padding: "8px",
    color: "var(--ink)",
    fontSize: fontSize.small,
  },
});
