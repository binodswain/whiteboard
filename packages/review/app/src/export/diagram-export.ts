import { FLOW_NODE_SIZE, layoutFlow } from "@canvas/flow-layout";

export type SequenceExportInput = {
  title: string;
  actors: Record<string, string>;
  steps: readonly {
    from: string;
    to: string;
    label: string;
    style?: "call" | "return" | "async";
  }[];
};

export type FlowExportInput = {
  title: string;
  direction?: "right" | "down";
  nodes: readonly {
    key: string;
    label: string;
    kind?: "process" | "decision" | "terminal";
  }[];
  edges: readonly {
    from: string;
    to: string;
    label?: string;
    style?: "solid" | "dashed";
  }[];
};

/** A C4 node as the software map already lays it out: ELK/libavoid gave it
 * `x`/`y`/`width`/`height`; `parentId` nests it inside an expanded boundary. */
export type C4ExportNode = {
  id: string;
  label: string;
  parentId?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type C4ExportRelationship = {
  from: string;
  to: string;
  label?: string;
};

export type C4ExportInput = {
  title: string;
  nodes: readonly C4ExportNode[];
  relationships: readonly C4ExportRelationship[];
};

const SEQUENCE_LANE_WIDTH = 176;

const SEQUENCE_MESSAGE_TOP = 112;

const SEQUENCE_MESSAGE_GAP = 76;

const SEQUENCE_PARTICIPANT_WIDTH = 148;

const SEQUENCE_PARTICIPANT_HEIGHT = 32;

const SEQUENCE_PARTICIPANT_Y = 24;

const DRAWIO_LIFELINE_WIDTH = 100;

const DRAWIO_LANE_WIDTH = 160;

// ---------------------------------------------------------------------------
// Filename
// ---------------------------------------------------------------------------

export function diagramExportFilename(title: string, ext: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "diagram";

  return `${slug}.${ext}`;
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/** Mermaid treats `#` as a comment and `;` as a statement break. */
export function escapeMermaidText(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/[#;]/g, (ch) =>
    ch === "#" ? "#35;" : "#59;",
  );
}

export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function mermaidId(id: string): string {
  const safe = escapeMermaidText(id).replace(/"/g, "");

  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(safe) ? safe : `"${safe}"`;
}

/** Flowchart node/subgraph ids are bare `NODE_STRING` tokens: Mermaid's
 * flowchart grammar has no quoted-id form (unlike sequence participants), so
 * this prefixes everything instead — the prefix also keeps an id from ever
 * colliding with a flowchart keyword like `end`. */
function mermaidFlowId(id: string): string {
  return `n_${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function mermaidNodeLabel(label: string): string {
  const safe = escapeMermaidText(label).replace(/"/g, "#quot;");

  return /[\[\](){}|]/.test(safe) ? `"${safe}"` : safe;
}

function actorEntries(actors: Record<string, string>): [string, string][] {
  return Object.entries(actors);
}

function participantIndex(actors: Record<string, string>): Map<string, number> {
  return new Map(actorEntries(actors).map(([id], index) => [id, index]));
}

function actorLabel(actors: Record<string, string>, id: string): string {
  return actors[id] ?? id;
}

function sequenceArrow(style: SequenceExportInput["steps"][number]["style"]) {
  return style === "return" ? "-->>"
    : style === "async" ? "-)"
    : "->>";
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

export function sequenceToMermaid(input: SequenceExportInput): string {
  const lines = ["sequenceDiagram"];

  for (const [key, label] of actorEntries(input.actors)) {
    lines.push(
      `    participant ${mermaidId(key)} as ${escapeMermaidText(label)}`,
    );
  }

  for (const step of input.steps) {
    lines.push(
      `    ${mermaidId(step.from)}${sequenceArrow(step.style)}${mermaidId(step.to)}: ${escapeMermaidText(step.label)}`,
    );
  }

  return lines.join("\n");
}

export function flowToMermaid(input: FlowExportInput): string {
  const dir = input.direction === "down" ? "TD" : "LR";
  const lines = [`flowchart ${dir}`];

  for (const node of input.nodes) {
    const label = mermaidNodeLabel(node.label);

    const nodeBox =
      node.kind === "decision"
        ? `{${label}}`
        : node.kind === "terminal"
          ? `([${label}])`
          : `[${label}]`;

    lines.push(`    ${mermaidFlowId(node.key)}${nodeBox}`);
  }

  for (const edge of input.edges) {
    const edgeLabel = edge.label ? `|${escapeMermaidText(edge.label)}|` : "";

    const arrow = edge.style === "dashed" ? "-.->" : "-->";
    lines.push(
      `    ${mermaidFlowId(edge.from)}${arrow}${edgeLabel}${mermaidFlowId(edge.to)}`,
    );
  }

  return lines.join("\n");
}

/** Visible-node ids only: a child whose ancestor isn't part of the exported
 * set (e.g. a collapsed parent) renders as its own root. */
function c4ParentOf(
  node: C4ExportNode,
  idSet: ReadonlySet<string>,
): string | null {
  return node.parentId && idSet.has(node.parentId) ? node.parentId : null;
}

function c4ChildrenByParent(
  nodes: readonly C4ExportNode[],
): Map<string | null, C4ExportNode[]> {
  const idSet = new Set(nodes.map((node) => node.id));
  const byParent = new Map<string | null, C4ExportNode[]>();

  for (const node of nodes) {
    const parentId = c4ParentOf(node, idSet);
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(node);
    byParent.set(parentId, siblings);
  }

  return byParent;
}

function c4VisibleRelationships(
  input: C4ExportInput,
): C4ExportRelationship[] {
  const idSet = new Set(input.nodes.map((node) => node.id));

  return input.relationships.filter(
    (relationship) => idSet.has(relationship.from) && idSet.has(relationship.to),
  );
}

/**
 * C4 maps onto a Mermaid `flowchart`, not `C4Context`/`C4Container`: the
 * software map's element kinds (person, system, container, data store,
 * component, code) don't line up with C4-PlantUML's fixed vocabulary, and a
 * flowchart losslessly keeps every node, the expand hierarchy (as nested
 * `subgraph`s — Mermaid allows edges to a subgraph itself) and relationship.
 */
export function c4ToMermaid(input: C4ExportInput): string {
  const byParent = c4ChildrenByParent(input.nodes);
  const lines = ["flowchart TD"];

  const renderNode = (node: C4ExportNode, indent: string) => {
    const children = byParent.get(node.id) ?? [];

    if (children.length > 0) {
      lines.push(
        `${indent}subgraph ${mermaidFlowId(node.id)}[${mermaidNodeLabel(node.label)}]`,
      );

      for (const child of children) renderNode(child, `${indent}    `);
      lines.push(`${indent}end`);
    } else {
      lines.push(`${indent}${mermaidFlowId(node.id)}[${mermaidNodeLabel(node.label)}]`);
    }
  };

  for (const node of byParent.get(null) ?? []) renderNode(node, "    ");

  for (const relationship of c4VisibleRelationships(input)) {
    const label = relationship.label
      ? `|${escapeMermaidText(relationship.label)}|`
      : "";

    lines.push(
      `    ${mermaidFlowId(relationship.from)}-->${label}${mermaidFlowId(relationship.to)}`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Excalidraw
// ---------------------------------------------------------------------------

type ExcalidrawElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: string;
  strokeWidth: number;
  strokeStyle: string;
  roughness: number;
  opacity: number;
  groupIds: string[];
  frameId: null;
  roundness: { type: number } | null;
  seed: number;
  version: number;
  versionNonce: number;
  isDeleted: false;
  boundElements: { id: string; type: string }[] | null;
  updated: number;
  link: null;
  locked: false;
  text?: string;
  originalText?: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  verticalAlign?: string;
  baseline?: number;
  containerId?: string | null;
  lineHeight?: number;
  autoResize?: boolean;
  points?: number[][];
  startArrowhead?: string | null;
  endArrowhead?: string | null;
};

export type ExcalidrawFile = {
  type: "excalidraw";
  version: 2;
  source: string;
  elements: ExcalidrawElement[];
  appState: { gridSize: null; viewBackgroundColor: string };
  files: Record<string, never>;
};

function fnv(id: string): number {
  let hash = 2166136261;

  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function excalidrawElement(
  id: string,
  type: string,
  box: { x: number; y: number; width: number; height: number },
  extra: Partial<ExcalidrawElement> = {},
): ExcalidrawElement {
  return {
    id,
    type,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor:
      type === "text" || type === "arrow" || type === "line"
        ? "transparent"
        : "#ffffff",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: type === "rectangle" ? { type: 3 } : null,
    seed: fnv(id),
    version: 1,
    versionNonce: fnv(`${id}:nonce`),
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    ...extra,
  };
}

function excalidrawText(
  id: string,
  text: string,
  box: { x: number; y: number; width: number; height: number },
  extra: Partial<ExcalidrawElement> = {},
): ExcalidrawElement {
  return excalidrawElement(id, "text", box, {
    text,
    originalText: text,
    fontSize: 16,
    fontFamily: 1,
    textAlign: "center",
    verticalAlign: "middle",
    baseline: box.height - 8,
    containerId: null,
    lineHeight: 1.25,
    autoResize: true,
    ...extra,
  });
}

function excalidrawFile(elements: ExcalidrawElement[]): ExcalidrawFile {
  return {
    type: "excalidraw",
    version: 2,
    source: "https://whiteboard.dev.fast",
    elements,
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files: {},
  };
}

function sequenceLaneCenter(index: number): number {
  return index * SEQUENCE_LANE_WIDTH + SEQUENCE_LANE_WIDTH / 2;
}

function sequenceParticipantBox(index: number) {
  return {
    x:
      index * SEQUENCE_LANE_WIDTH +
      (SEQUENCE_LANE_WIDTH - SEQUENCE_PARTICIPANT_WIDTH) / 2,
    y: SEQUENCE_PARTICIPANT_Y,
    width: SEQUENCE_PARTICIPANT_WIDTH,
    height: SEQUENCE_PARTICIPANT_HEIGHT,
  };
}

function sequenceHeight(stepCount: number): number {
  return SEQUENCE_MESSAGE_TOP + stepCount * SEQUENCE_MESSAGE_GAP + 42;
}

export function sequenceToExcalidraw(input: SequenceExportInput): string {
  const actors = actorEntries(input.actors);
  const indexOf = participantIndex(input.actors);
  const height = sequenceHeight(input.steps.length);
  const elements: ExcalidrawElement[] = [];

  for (const [index, [id, label]] of actors.entries()) {
    const box = sequenceParticipantBox(index);
    const rectId = `participant:${id}`;
    const textId = `participant-text:${id}`;
    const lineId = `lifeline:${id}`;
    const centerX = sequenceLaneCenter(index);
    elements.push(
      excalidrawElement(rectId, "rectangle", box, {
        boundElements: [{ id: textId, type: "text" }],
      }),
      excalidrawText(textId, label, box, { containerId: rectId }),
      excalidrawElement(
        lineId,
        "line",
        {
          x: centerX,
          y: 62,
          width: 0,
          height: height - 80,
        },
        {
          points: [
            [0, 0],
            [0, height - 80],
          ],
          strokeStyle: "dashed",
        },
      ),
    );
  }

  for (const [index, step] of input.steps.entries()) {
    const from = indexOf.get(step.from) ?? 0;
    const to = indexOf.get(step.to) ?? 0;
    const y = SEQUENCE_MESSAGE_TOP + index * SEQUENCE_MESSAGE_GAP;
    const fromX = sequenceLaneCenter(from);
    const toX = sequenceLaneCenter(to);
    const self = step.from === step.to;
    const arrowId = `message:${index}`;
    const labelId = `message-label:${index}`;
    const x = self ? fromX : Math.min(fromX, toX);
    const width = self ? 48 : Math.abs(toX - fromX);

    const points = self
      ? [
          [0, 0],
          [48, 0],
          [48, 24],
          [0, 24],
        ]
      : [
          [fromX <= toX ? 0 : width, 0],
          [fromX <= toX ? width : 0, 0],
        ];

    elements.push(
      excalidrawElement(
        arrowId,
        "arrow",
        { x, y: self ? y : y, width, height: self ? 24 : 0 },
        {
          points,
          startArrowhead: null,
          endArrowhead: step.style === "async" ? "arrow" : "triangle",
          strokeStyle: step.style === "return" ? "dashed" : "solid",
          boundElements: [{ id: labelId, type: "text" }],
        },
      ),
      excalidrawText(
        labelId,
        step.label,
        {
          x: self ? fromX + 8 : x + width / 2 - 60,
          y: self ? y - 18 : y - 18,
          width: self ? 80 : Math.max(120, width - 12),
          height: 20,
        },
        { fontSize: 14, containerId: null },
      ),
    );
  }

  return JSON.stringify(excalidrawFile(elements));
}

export async function flowToExcalidraw(
  input: FlowExportInput,
): Promise<string> {
  const layout = await layoutFlow(input, input.direction);
  const elements: ExcalidrawElement[] = [];

  const nodeKind = new Map(
    input.nodes.map((node) => [node.key, node.kind ?? "process"]),
  );

  for (const node of input.nodes) {
    const position = layout.nodes.get(node.key) ?? { x: 0, y: 0 };
    const box = { ...position, ...FLOW_NODE_SIZE };
    const rectId = `node:${node.key}`;
    const textId = `node-text:${node.key}`;
    const kind = nodeKind.get(node.key);
    elements.push(
      excalidrawElement(
        rectId,
        kind === "decision"
          ? "diamond"
          : kind === "terminal"
            ? "ellipse"
            : "rectangle",
        box,
        { boundElements: [{ id: textId, type: "text" }] },
      ),
      excalidrawText(textId, node.label, box, { containerId: rectId }),
    );
  }

  for (const [index, edge] of input.edges.entries()) {
    const section = layout.edges.find((item) => item.index === index);
    const points = section?.points ?? [];
    const start = points[0] ?? { x: 0, y: 0 };
    const end = points[points.length - 1] ?? start;

    const locals = points.map((point) => [
      point.x - start.x,
      point.y - start.y,
    ]);

    const xs = locals.map((point) => point[0]!);
    const ys = locals.map((point) => point[1]!);
    const minX = Math.min(0, ...xs);
    const minY = Math.min(0, ...ys);
    const arrowId = `edge:${index}`;
    const labelId = `edge-label:${index}`;
    elements.push(
      excalidrawElement(
        arrowId,
        "arrow",
        {
          x: start.x,
          y: start.y,
          width: Math.max(1, Math.max(...xs) - minX),
          height: Math.max(1, Math.max(...ys) - minY),
        },
        {
          points:
            locals.length > 1
              ? locals
              : [
                  [0, 0],
                  [end.x - start.x, end.y - start.y],
                ],
          startArrowhead: null,
          endArrowhead: "triangle",
          strokeStyle: edge.style === "dashed" ? "dashed" : "solid",
          boundElements: edge.label ? [{ id: labelId, type: "text" }] : null,
        },
      ),
    );

    if (edge.label) {
      const label = section?.label ?? {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2,
      };

      elements.push(
        excalidrawText(
          labelId,
          edge.label,
          { x: label.x, y: label.y - 10, width: 120, height: 18 },
          { fontSize: 12 },
        ),
      );
    }
  }

  return JSON.stringify(excalidrawFile(elements));
}

/**
 * C4 is already laid out (ELK/libavoid gave every node an absolute box), so
 * this draws boundaries and leaves at their given positions and connects
 * relationships center-to-center; no re-layout needed.
 */
export function c4ToExcalidraw(input: C4ExportInput): string {
  const elements: ExcalidrawElement[] = [];
  const byId = new Map(input.nodes.map((node) => [node.id, node]));

  // Boundaries (nodes with children) draw first so leaves sit visually on top.
  const hasChildren = new Set(
    input.nodes.flatMap((node) => (node.parentId ? [node.parentId] : [])),
  );

  const ordered = [...input.nodes].sort(
    (a, b) => Number(hasChildren.has(b.id)) - Number(hasChildren.has(a.id)),
  );

  for (const node of ordered) {
    const box = { x: node.x, y: node.y, width: node.width, height: node.height };
    const rectId = `node:${node.id}`;
    const textId = `node-text:${node.id}`;
    elements.push(
      excalidrawElement(rectId, "rectangle", box, {
        boundElements: [{ id: textId, type: "text" }],
      }),
      excalidrawText(textId, node.label, box, { containerId: rectId }),
    );
  }

  for (const [index, relationship] of c4VisibleRelationships(input).entries()) {
    const from = byId.get(relationship.from)!;
    const to = byId.get(relationship.to)!;
    const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
    const arrowId = `edge:${index}`;
    const labelId = `edge-label:${index}`;

    elements.push(
      excalidrawElement(
        arrowId,
        "arrow",
        {
          x: start.x,
          y: start.y,
          width: Math.max(1, Math.abs(end.x - start.x)),
          height: Math.max(1, Math.abs(end.y - start.y)),
        },
        {
          points: [
            [0, 0],
            [end.x - start.x, end.y - start.y],
          ],
          startArrowhead: null,
          endArrowhead: "triangle",
          boundElements: relationship.label
            ? [{ id: labelId, type: "text" }]
            : null,
        },
      ),
    );

    if (relationship.label) {
      elements.push(
        excalidrawText(
          labelId,
          relationship.label,
          {
            x: (start.x + end.x) / 2 - 60,
            y: (start.y + end.y) / 2 - 10,
            width: 120,
            height: 18,
          },
          { fontSize: 12 },
        ),
      );
    }
  }

  return JSON.stringify(excalidrawFile(elements));
}

// ---------------------------------------------------------------------------
// draw.io (mxGraph XML)
// ---------------------------------------------------------------------------

function mxGeometry(
  x: number,
  y: number,
  width: number,
  height: number,
  extra = "",
): string {
  return `<mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry"${extra ? `>${extra}</mxGeometry>` : "/>"}`;
}

function mxFile(title: string, cells: string): string {
  return `<mxfile host="Whiteboard" agent="Whiteboard" version="22.1.16"><diagram id="diagram" name="${xmlEscape(title)}"><mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel></diagram></mxfile>`;
}

function sequenceMessageStyle(
  style: SequenceExportInput["steps"][number]["style"],
): string {
  return style === "return"
    ? "html=1;verticalAlign=bottom;endArrow=open;dashed=1;rounded=0;"
    : style === "async"
      ? "html=1;verticalAlign=bottom;endArrow=open;endFill=0;rounded=0;"
      : "html=1;verticalAlign=bottom;endArrow=block;endFill=1;rounded=0;";
}

export function sequenceToDrawio(input: SequenceExportInput): string {
  const actors = actorEntries(input.actors);
  const indexOf = participantIndex(input.actors);
  const height = Math.max(160, 80 + input.steps.length * 60);
  const cells: string[] = [];

  for (const [index, [id, label]] of actors.entries()) {
    cells.push(
      `<mxCell id="p:${xmlEscape(id)}" value="${xmlEscape(label)}" style="shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;container=1;collapsible=0;recursiveResize=0;outlineConnect=0;" vertex="1" parent="1">${mxGeometry(40 + index * DRAWIO_LANE_WIDTH, 40, DRAWIO_LIFELINE_WIDTH, height)}</mxCell>`,
    );
  }

  for (const [index, step] of input.steps.entries()) {
    const y = 100 + index * 60;
    const self = step.from === step.to;

    const extra = self
      ? `<Array as="points"><mxPoint x="${40 + (indexOf.get(step.from) ?? 0) * DRAWIO_LANE_WIDTH + DRAWIO_LIFELINE_WIDTH + 36}" y="${y}"/></Array>`
      : "";

    cells.push(
      `<mxCell id="m:${index}" value="${xmlEscape(step.label)}" style="${sequenceMessageStyle(step.style)}" edge="1" parent="1" source="p:${xmlEscape(step.from)}" target="p:${xmlEscape(step.to)}"><mxGeometry relative="1" as="geometry"${extra ? `>${extra}</mxGeometry>` : "/>"}</mxCell>`,
    );
  }

  return mxFile(input.title, cells.join(""));
}

function flowNodeStyle(kind: FlowExportInput["nodes"][number]["kind"]): string {
  return kind === "decision"
    ? "rhombus;whiteSpace=wrap;html=1;"
    : kind === "terminal"
      ? "ellipse;whiteSpace=wrap;html=1;"
      : "rounded=1;whiteSpace=wrap;html=1;";
}

export async function flowToDrawio(input: FlowExportInput): Promise<string> {
  const layout = await layoutFlow(input, input.direction);
  const cells: string[] = [];

  for (const node of input.nodes) {
    const position = layout.nodes.get(node.key) ?? { x: 0, y: 0 };
    cells.push(
      `<mxCell id="n:${xmlEscape(node.key)}" value="${xmlEscape(node.label)}" style="${flowNodeStyle(node.kind)}" vertex="1" parent="1">${mxGeometry(position.x, position.y, FLOW_NODE_SIZE.width, FLOW_NODE_SIZE.height)}</mxCell>`,
    );
  }

  for (const [index, edge] of input.edges.entries()) {
    const section = layout.edges.find((item) => item.index === index);
    const mid = section?.points.slice(1, -1) ?? [];

    const points = mid.length
      ? `<Array as="points">${mid.map((point) => `<mxPoint x="${point.x}" y="${point.y}"/>`).join("")}</Array>`
      : "";

    const dashed = edge.style === "dashed" ? "dashed=1;" : "";
    cells.push(
      `<mxCell id="e:${index}" value="${xmlEscape(edge.label ?? "")}" style="endArrow=block;endFill=1;html=1;${dashed}" edge="1" parent="1" source="n:${xmlEscape(edge.from)}" target="n:${xmlEscape(edge.to)}"><mxGeometry relative="1" as="geometry"${points ? `>${points}</mxGeometry>` : "/>"}</mxCell>`,
    );
  }

  return mxFile(input.title, cells.join(""));
}

/** Boundaries (nodes with children) render first as unfilled containers so
 * leaf nodes draw visually inside them; everything stays on the one
 * coordinate space the C4 layout already computed. */
export function c4ToDrawio(input: C4ExportInput): string {
  const hasChildren = new Set(
    input.nodes.flatMap((node) => (node.parentId ? [node.parentId] : [])),
  );

  const ordered = [...input.nodes].sort(
    (a, b) => Number(hasChildren.has(b.id)) - Number(hasChildren.has(a.id)),
  );

  const cells: string[] = [];

  for (const node of ordered) {
    const style = hasChildren.has(node.id)
      ? "rounded=1;whiteSpace=wrap;html=1;verticalAlign=top;fillColor=none;"
      : "rounded=1;whiteSpace=wrap;html=1;";

    cells.push(
      `<mxCell id="n:${xmlEscape(node.id)}" value="${xmlEscape(node.label)}" style="${style}" vertex="1" parent="1">${mxGeometry(node.x, node.y, node.width, node.height)}</mxCell>`,
    );
  }

  for (const [index, relationship] of c4VisibleRelationships(input).entries()) {
    cells.push(
      `<mxCell id="e:${index}" value="${xmlEscape(relationship.label ?? "")}" style="endArrow=block;endFill=1;html=1;" edge="1" parent="1" source="n:${xmlEscape(relationship.from)}" target="n:${xmlEscape(relationship.to)}"><mxGeometry relative="1" as="geometry"/></mxCell>`,
    );
  }

  return mxFile(input.title, cells.join(""));
}

// ---------------------------------------------------------------------------
// XMind (zip of JSON sheets)
// ---------------------------------------------------------------------------

type XmindTopic = {
  id: string;
  class: "topic";
  title: string;
  children?: { attached: XmindTopic[] };
};

function xmindTopic(
  id: string,
  title: string,
  children: XmindTopic[],
): XmindTopic {
  return children.length
    ? { id, class: "topic", title, children: { attached: children } }
    : { id, class: "topic", title };
}

function xmindFile(title: string, children: XmindTopic[]): Uint8Array {
  const sheet = {
    id: "sheet-1",
    class: "sheet",
    title,
    rootTopic: xmindTopic("root", title, children),
  };

  return zipStore({
    "content.json": JSON.stringify([sheet]),
    "metadata.json": JSON.stringify({
      creator: { name: "Whiteboard", version: "1.0" },
    }),
    "manifest.json": JSON.stringify({
      "file-entries": {
        "content.json": {},
        "metadata.json": {},
      },
    }),
  });
}

export function sequenceToXmind(input: SequenceExportInput): Uint8Array {
  const children = actorEntries(input.actors).map(([id, label], actorIndex) => {
    const steps = input.steps
      .filter((step) => step.from === id)
      .map((step, stepIndex) =>
        xmindTopic(
          `step:${actorIndex}:${stepIndex}`,
          `${step.label} → ${actorLabel(input.actors, step.to)}`,
          [],
        ),
      );

    return xmindTopic(`actor:${id}`, label, steps);
  });

  return xmindFile(input.title, children);
}

export function flowToXmind(input: FlowExportInput): Uint8Array {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const node of input.nodes) {
    incoming.set(node.key, 0);
    outgoing.set(node.key, []);
  }

  for (const edge of input.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }

  const byKey = new Map(input.nodes.map((node) => [node.key, node]));
  const visited = new Set<string>();

  const walk = (key: string): XmindTopic => {
    visited.add(key);
    const node = byKey.get(key);
    const childKeys = outgoing.get(key) ?? [];
    const children: XmindTopic[] = [];

    for (const child of childKeys) {
      if (visited.has(child) || !byKey.has(child)) continue;
      children.push(walk(child));
    }

    return xmindTopic(`node:${key}`, node?.label ?? key, children);
  };

  const roots = input.nodes.filter(
    (node) => (incoming.get(node.key) ?? 0) === 0,
  );

  const attached: XmindTopic[] = [];

  for (const node of roots.length ? roots : input.nodes.slice(0, 1)) {
    if (!visited.has(node.key)) attached.push(walk(node.key));
  }

  for (const node of input.nodes) {
    if (!visited.has(node.key)) attached.push(walk(node.key));
  }

  return xmindFile(input.title, attached);
}

/** C4 already has its hierarchy (expand tree); XMind maps it directly, no
 * traversal heuristics needed the way flow's arbitrary graph does. */
export function c4ToXmind(input: C4ExportInput): Uint8Array {
  const byParent = c4ChildrenByParent(input.nodes);

  const walk = (node: C4ExportNode): XmindTopic =>
    xmindTopic(
      `node:${node.id}`,
      node.label,
      (byParent.get(node.id) ?? []).map(walk),
    );

  const roots = (byParent.get(null) ?? []).map(walk);

  return xmindFile(input.title, roots);
}

// ---------------------------------------------------------------------------
// ZIP (store method) for .xmind
// ---------------------------------------------------------------------------

function crc32(bytes: Uint8Array): number {
  let crc = ~0;

  for (const byte of bytes) {
    crc ^= byte;

    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }

  return ~crc >>> 0;
}

function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);

  return bytes;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);

  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

export function zipStore(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const entries = Object.entries(files);

  for (const [name, content] of entries) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
    const crc = crc32(data);

    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      data,
    ]);

    const central = concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes,
    ]);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const centralDir = concat(centrals);

  return concat([
    ...locals,
    centralDir,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);
}

export function unzipStore(zip: Uint8Array): Map<string, string> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const decoder = new TextDecoder();
  const files = new Map<string, string>();
  let cursor = 0;

  while (
    cursor + 30 <= zip.length &&
    view.getUint32(cursor, true) === 0x04034b50
  ) {
    const compact = view.getUint32(cursor + 18, true);
    const nameLen = view.getUint16(cursor + 26, true);
    const extraLen = view.getUint16(cursor + 28, true);
    const nameStart = cursor + 30;
    const name = decoder.decode(zip.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    files.set(
      name,
      decoder.decode(zip.subarray(dataStart, dataStart + compact)),
    );
    cursor = dataStart + compact;
  }

  return files;
}
