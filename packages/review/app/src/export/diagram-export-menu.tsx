import { copyText } from "@canvas/copy-text";
import { diagramStyles } from "@canvas/diagram-styles";
import { withClass } from "@canvas/stylex-props";
import { menuStyles } from "@canvas/ui/menu";
import { surfaceStyles } from "@canvas/ui/surface";
import { useAnchoredPopover } from "@canvas/use-anchored-popover";
import { useDismissOnOutside } from "@canvas/use-dismiss-on-outside";
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

async function exportDiagram(
  source: DiagramExportSource,
  id: (typeof ITEMS)[number]["id"],
) {
  const name = (ext: string) => diagramExportFilename(source.title, ext);

  if (id === "copy-mermaid") {
    await copyText(diagramMermaid(source));

    return;
  }

  if (id === "download-mermaid") {
    download(diagramMermaid(source), "text/plain", name("mmd"));

    return;
  }

  if (id === "download-excalidraw") {
    download(
      await diagramExcalidraw(source),
      "application/json",
      name("excalidraw"),
    );

    return;
  }

  if (id === "download-drawio") {
    download(await diagramDrawio(source), "application/xml", name("drawio"));

    return;
  }

  downloadBytes(
    diagramXmind(source),
    "application/vnd.xmind.workbook",
    name("xmind"),
  );
}

export function DiagramExportMenu({
  source,
}: {
  source: DiagramExportSource;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const menu = useAnchoredPopover(open, container);
  useDismissOnOutside(container, open, setOpen);

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
          {...stylex.props(
            surfaceStyles.popover,
            menuStyles.popover,
            menuStyles.end,
            styles.list,
          )}
        >
          {ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              {...stylex.props(menuStyles.item)}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                void exportDiagram(source, item.id);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
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
});
