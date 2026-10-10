import type { ElkNode } from "elkjs/lib/elk.bundled.js";

import { loadElk } from "./elk";

export interface FlowLayout {
  width: number;
  height: number;
  nodes: Map<string, { x: number; y: number }>;
  edges: {
    index: number;
    section: number;
    points: { x: number; y: number }[];
    label?: { text: string; x: number; y: number };
  }[];
}

export const FLOW_NODE_SIZE = { width: 210, height: 62 };

// The label's 9px mono font, so ELK leaves room for it between layers.
const LABEL = { charWidth: 5.4, height: 12, maxLength: 28 };

const labelText = (label: string) =>
  label.length > LABEL.maxLength
    ? `${label.slice(0, LABEL.maxLength - 1)}…`
    : label;

export async function layoutFlow(
  block: {
    nodes: readonly { key: string }[];
    edges: readonly { from: string; to: string; label?: string }[];
  },
  direction: "down" | "right" | undefined,
): Promise<FlowLayout> {
  const elk = await loadElk();

  const result = await elk.layout<ElkNode>({
    id: "flow",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction === "right" ? "RIGHT" : "DOWN",
      "elk.spacing.nodeNode": "28",
      "elk.layered.spacing.nodeNodeBetweenLayers": "44",
    },
    children: block.nodes.map((node) => ({ id: node.key, ...FLOW_NODE_SIZE })),
    edges: block.edges.map((edge, index) => {
      const text = edge.label && labelText(edge.label);

      return {
        id: String(index),
        sources: [edge.from],
        targets: [edge.to],
        labels: text
          ? [
              {
                text,
                width: text.length * LABEL.charWidth,
                height: LABEL.height,
                // Beside the source, so the label widens its own gap
                // instead of getting a layer of its own.
                layoutOptions: { "elk.edgeLabels.placement": "TAIL" },
              },
            ]
          : [],
      };
    }),
  });

  return {
    width: result.width ?? 240,
    height: result.height ?? 100,
    nodes: new Map(
      result.children?.map((node) => [
        node.id,
        { x: node.x ?? 0, y: node.y ?? 0 },
      ]),
    ),
    edges: (result.edges ?? []).flatMap((edge) =>
      (edge.sections ?? []).map((section, index) => {
        const label = index ? undefined : edge.labels?.[0];

        return {
          index: Number(edge.id),
          section: index,
          points: [
            section.startPoint,
            ...(section.bendPoints ?? []),
            section.endPoint,
          ],
          label: label && {
            text: label.text ?? "",
            x: label.x ?? 0,
            y: (label.y ?? 0) + LABEL.height - 3,
          },
        };
      }),
    ),
  };
}
