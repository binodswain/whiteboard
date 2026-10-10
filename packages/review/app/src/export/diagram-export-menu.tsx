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
  type FlowExportInput,
  type SequenceExportInput,
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
  | ({ kind: "flow" } & FlowExportInput);

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

async function exportDiagram(
  source: DiagramExportSource,
  id: (typeof ITEMS)[number]["id"],
) {
  const mermaid =
    source.kind === "sequence"
      ? sequenceToMermaid(source)
      : flowToMermaid(source);

  const name = (ext: string) => diagramExportFilename(source.title, ext);

  if (id === "copy-mermaid") {
    await copyText(mermaid);

    return;
  }

  if (id === "download-mermaid") {
    download(mermaid, "text/plain", name("mmd"));

    return;
  }

  if (id === "download-excalidraw") {
    download(
      source.kind === "sequence"
        ? sequenceToExcalidraw(source)
        : await flowToExcalidraw(source),
      "application/json",
      name("excalidraw"),
    );

    return;
  }

  if (id === "download-drawio") {
    download(
      source.kind === "sequence"
        ? sequenceToDrawio(source)
        : await flowToDrawio(source),
      "application/xml",
      name("drawio"),
    );

    return;
  }

  downloadBytes(
    source.kind === "sequence" ? sequenceToXmind(source) : flowToXmind(source),
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
