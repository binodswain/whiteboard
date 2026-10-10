// @vitest-environment jsdom
import mermaid from "mermaid";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

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
  unzipStore,
  xmlEscape,
} from "./diagram-export.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sequence: SequenceExportInput = {
  title: "Login",
  actors: { client: "Client", server: "Server" },
  steps: [
    { from: "client", to: "server", label: "POST /login", style: "call" },
    { from: "server", to: "client", label: "200 OK", style: "return" },
    { from: "client", to: "client", label: "cache token", style: "async" },
  ],
};

const reservedSequence: SequenceExportInput = {
  title: "Reserved",
  actors: { "client-api": "Client & Co <v1>" },
  steps: [
    {
      from: "client-api",
      to: "client-api",
      label: "Wait #1; then go",
      style: "call",
    },
  ],
};

const flow: FlowExportInput = {
  title: "Auth flow",
  direction: "right",
  nodes: [
    { key: "start", label: "Start", kind: "terminal" },
    { key: "check", label: "Token valid?", kind: "decision" },
    { key: "ok", label: "Allow", kind: "process" },
  ],
  edges: [
    { from: "start", to: "check", label: "next" },
    { from: "check", to: "ok", label: "yes", style: "dashed" },
  ],
};

const reservedFlow: FlowExportInput = {
  title: "Chars",
  nodes: [
    { key: "a-1", label: 'Gate [open] & "go"', kind: "process" },
    { key: "end", label: "Done #now;", kind: "terminal" },
  ],
  edges: [{ from: "a-1", to: "end", label: "A < B" }],
};

const c4: C4ExportInput = {
  title: "Billing context",
  nodes: [
    { id: "person", label: "Customer", x: 0, y: 0, width: 200, height: 100 },
    {
      id: "system",
      label: "Billing System",
      x: 300,
      y: 0,
      width: 400,
      height: 300,
    },
    {
      id: "service",
      label: "Billing Service",
      parentId: "system",
      x: 320,
      y: 40,
      width: 200,
      height: 100,
    },
  ],
  relationships: [
    { from: "person", to: "system", label: "Uses" },
    { from: "system", to: "service", label: "Routes to" },
  ],
};

const reservedC4: C4ExportInput = {
  title: "C4 chars",
  nodes: [
    {
      id: "a-1",
      label: 'Gate [open] & "go"',
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    },
    { id: "b", label: "Done #now;", x: 200, y: 0, width: 100, height: 50 },
  ],
  relationships: [{ from: "a-1", to: "b", label: "A < B" }],
};

// ---------------------------------------------------------------------------
// Mermaid — parsed by mermaid's own parser, not a hand-rolled regex
// ---------------------------------------------------------------------------

beforeAll(() => {
  mermaid.initialize({ startOnLoad: false });
});

interface MermaidSequenceMessage {
  from: string;
  to: string;
  message: string;
}

interface MermaidFlowVertex {
  id: string;
  text: string;
  type: string;
}

interface MermaidFlowEdge {
  start: string;
  end: string;
  text: string;
  stroke: string;
}

interface MermaidSubGraph {
  id: string;
  title: string;
  nodes: string[];
}

interface MermaidDiagramDb {
  getActorKeys?(): string[];
  getMessages?(): MermaidSequenceMessage[];
  getVertices?(): Map<string, MermaidFlowVertex>;
  getEdges?(): MermaidFlowEdge[];
  getSubGraphs?(): MermaidSubGraph[];
}

async function mermaidDiagram(source: string) {
  // `parse` is the acceptance gate: it throws on invalid Mermaid syntax.
  const parsed = await mermaid.parse(source);
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);

  return { parsed, db: diagram.db as MermaidDiagramDb };
}

describe("sequence mermaid", () => {
  it("parses into the actors and messages mermaid's sequence parser reads", async () => {
    const { parsed, db } = await mermaidDiagram(sequenceToMermaid(sequence));

    expect(parsed?.diagramType).toBe("sequence");
    expect(db.getActorKeys!()).toEqual(["client", "server"]);
    expect(
      db.getMessages!().map((message) => ({
        from: message.from,
        to: message.to,
        message: message.message,
      })),
    ).toEqual([
      { from: "client", to: "server", message: "POST /login" },
      { from: "server", to: "client", message: "200 OK" },
      { from: "client", to: "client", message: "cache token" },
    ]);
  });

  it("escapes Mermaid-reserved characters so the parser still accepts the diagram", async () => {
    const { parsed, db } = await mermaidDiagram(
      sequenceToMermaid(reservedSequence),
    );

    expect(parsed?.diagramType).toBe("sequence");
    expect(db.getActorKeys!()).toEqual(["client-api"]);

    const messages = db.getMessages!();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ from: "client-api", to: "client-api" });
  });
});

describe("flow mermaid", () => {
  it("parses into the node shapes and edge strokes mermaid's flowchart parser reads", async () => {
    const { parsed, db } = await mermaidDiagram(flowToMermaid(flow));

    expect(parsed?.diagramType).toBe("flowchart-v2");

    const vertices = db.getVertices!();

    expect(
      [...vertices.values()].map((vertex) => ({
        id: vertex.id,
        text: vertex.text,
        type: vertex.type,
      })),
    ).toEqual([
      { id: "n_start", text: "Start", type: "stadium" },
      { id: "n_check", text: "Token valid?", type: "diamond" },
      { id: "n_ok", text: "Allow", type: "square" },
    ]);

    const edges = db.getEdges!();

    expect(
      edges.map((edge) => ({
        start: edge.start,
        end: edge.end,
        text: edge.text,
        stroke: edge.stroke,
      })),
    ).toEqual([
      { start: "n_start", end: "n_check", text: "next", stroke: "normal" },
      { start: "n_check", end: "n_ok", text: "yes", stroke: "dotted" },
    ]);
  });

  it("quotes ids and labels that Mermaid would otherwise choke on", async () => {
    const { parsed, db } = await mermaidDiagram(flowToMermaid(reservedFlow));

    expect(parsed?.diagramType).toBe("flowchart-v2");

    const vertices = db.getVertices!();
    expect([...vertices.keys()]).toEqual(["n_a-1", "n_end"]);

    const edges = db.getEdges!();
    expect(edges.map((edge) => ({ start: edge.start, end: edge.end }))).toEqual(
      [{ start: "n_a-1", end: "n_end" }],
    );
  });
});

describe("C4 mermaid", () => {
  it("parses into a flowchart whose subgraph is the C4 boundary and whose leaves/edges are the nodes and relationships", async () => {
    const { parsed, db } = await mermaidDiagram(c4ToMermaid(c4));

    expect(parsed?.diagramType).toBe("flowchart-v2");

    const subGraphs = db.getSubGraphs!();

    expect(
      subGraphs.map((subGraph) => ({
        id: subGraph.id,
        title: subGraph.title,
        nodes: subGraph.nodes,
      })),
    ).toEqual([
      { id: "n_system", title: "Billing System", nodes: ["n_service"] },
    ]);

    const vertices = db.getVertices!();
    expect(vertices.get("n_person")).toMatchObject({ text: "Customer" });
    expect(vertices.get("n_service")).toMatchObject({
      text: "Billing Service",
    });

    const edges = db.getEdges!();
    expect(
      edges.map((edge) => ({
        start: edge.start,
        end: edge.end,
        text: edge.text,
      })),
    ).toEqual([
      { start: "n_person", end: "n_system", text: "Uses" },
      { start: "n_system", end: "n_service", text: "Routes to" },
    ]);
  });

  it("escapes reserved characters so the C4 flowchart still parses", async () => {
    const { parsed, db } = await mermaidDiagram(c4ToMermaid(reservedC4));

    expect(parsed?.diagramType).toBe("flowchart-v2");

    const vertices = db.getVertices!();
    expect([...vertices.keys()]).toEqual(["n_a-1", "n_b"]);

    const edges = db.getEdges!();
    expect(edges.map((edge) => ({ start: edge.start, end: edge.end }))).toEqual(
      [{ start: "n_a-1", end: "n_b" }],
    );
  });
});

// ---------------------------------------------------------------------------
// Excalidraw — validated against its own element schema
// ---------------------------------------------------------------------------

const excalidrawElementSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .passthrough();

const excalidrawFileSchema = z.object({
  type: z.literal("excalidraw"),
  version: z.literal(2),
  elements: z.array(excalidrawElementSchema).min(1),
  appState: z.object({ viewBackgroundColor: z.string() }).passthrough(),
  files: z.record(z.string(), z.unknown()),
});

function parseExcalidraw(json: string) {
  return excalidrawFileSchema.parse(JSON.parse(json));
}

describe("sequence excalidraw", () => {
  it("round-trips through the excalidraw schema with participant and message labels", () => {
    const file = parseExcalidraw(sequenceToExcalidraw(sequence));

    const texts = file.elements
      .values()
      .filter((element) => element.type === "text")
      .map((element) => String(element.text))
      .toArray();

    expect(texts).toEqual(
      expect.arrayContaining(["Client", "Server", "POST /login", "200 OK"]),
    );
    expect(file.elements.some((element) => element.type === "rectangle")).toBe(
      true,
    );
    expect(file.elements.some((element) => element.type === "arrow")).toBe(
      true,
    );
  });
});

describe("flow excalidraw", () => {
  it("round-trips ELK-positioned nodes through the excalidraw schema", async () => {
    const file = parseExcalidraw(await flowToExcalidraw(flow));

    const texts = file.elements
      .values()
      .filter((element) => element.type === "text")
      .map((element) => String(element.text))
      .toArray();

    expect(texts).toEqual(
      expect.arrayContaining(["Start", "Token valid?", "Allow", "next", "yes"]),
    );

    const start = file.elements.find((element) => element.id === "node:start");
    const check = file.elements.find((element) => element.id === "node:check");
    expect(start).toMatchObject({ type: "ellipse" });
    expect(check).toMatchObject({ type: "diamond" });
    expect(start?.x).not.toBe(check?.x);
  });
});

describe("C4 excalidraw", () => {
  it("draws every node at its given ELK/libavoid box and connects relationships", () => {
    const file = parseExcalidraw(c4ToExcalidraw(c4));

    const texts = file.elements
      .values()
      .filter((element) => element.type === "text")
      .map((element) => String(element.text))
      .toArray();

    expect(texts).toEqual(
      expect.arrayContaining([
        "Customer",
        "Billing System",
        "Billing Service",
        "Uses",
        "Routes to",
      ]),
    );

    const service = file.elements.find(
      (element) => element.id === "node:service",
    );

    expect(service).toMatchObject({ x: 320, y: 40, width: 200, height: 100 });
  });
});

// ---------------------------------------------------------------------------
// draw.io — parsed by a real XML parser (jsdom's DOMParser), not a regex
// ---------------------------------------------------------------------------

interface DrawioCell {
  id: string;
  value: string;
  style: string;
  vertex: boolean;
  edge: boolean;
  source?: string;
  target?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

function drawioCells(xml: string): DrawioCell[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const parserErrors = doc.getElementsByTagName("parsererror");

  if (parserErrors.length > 0) {
    throw new Error(
      `draw.io XML failed to parse: ${parserErrors[0]!.textContent}`,
    );
  }

  return doc
    .querySelectorAll("mxCell")
    .values()
    .filter((cell) => {
      const id = cell.getAttribute("id");

      return id !== "0" && id !== "1";
    })
    .map((cell) => {
      const geometry = cell.querySelector("mxGeometry");

      const numericAttr = (name: string) => {
        const value = geometry?.getAttribute(name);

        return value !== null && value !== undefined
          ? Number(value)
          : undefined;
      };

      return {
        id: cell.getAttribute("id") ?? "",
        value: cell.getAttribute("value") ?? "",
        style: cell.getAttribute("style") ?? "",
        vertex: cell.getAttribute("vertex") === "1",
        edge: cell.getAttribute("edge") === "1",
        source: cell.getAttribute("source") ?? undefined,
        target: cell.getAttribute("target") ?? undefined,
        x: numericAttr("x"),
        y: numericAttr("y"),
        width: numericAttr("width"),
        height: numericAttr("height"),
      };
    })
    .toArray();
}

describe("sequence draw.io", () => {
  it("round-trips lifelines and message styles through mxGraph XML", () => {
    const cells = drawioCells(sequenceToDrawio(sequence));
    const vertices = cells.filter((cell) => cell.vertex);
    const edges = cells.filter((cell) => cell.edge);

    expect(vertices.map((cell) => cell.value)).toEqual(["Client", "Server"]);
    expect(vertices.every((cell) => cell.style.includes("umlLifeline"))).toBe(
      true,
    );
    expect(edges.map((cell) => cell.value)).toEqual([
      "POST /login",
      "200 OK",
      "cache token",
    ]);
    expect(edges[0]?.style).toContain("endArrow=block");
    expect(edges[1]?.style).toContain("dashed=1");
    expect(edges[2]?.style).toContain("endArrow=open");
    expect(edges[0]?.source).toBe("p:client");
    expect(edges[0]?.target).toBe("p:server");
  });

  it("xml-escapes labels so the parse recovers the original text", () => {
    const cells = drawioCells(sequenceToDrawio(reservedSequence));
    expect(cells.find((cell) => cell.vertex)?.value).toBe("Client & Co <v1>");
    expect(xmlEscape("Client & Co <v1>")).toContain("&amp;");
  });
});

describe("flow draw.io", () => {
  it("round-trips ELK positions and connectors through mxGraph XML", async () => {
    const cells = drawioCells(await flowToDrawio(flow));
    const vertices = cells.filter((cell) => cell.vertex);
    const edges = cells.filter((cell) => cell.edge);

    expect(vertices.map((cell) => cell.value)).toEqual([
      "Start",
      "Token valid?",
      "Allow",
    ]);
    expect(vertices[0]?.style).toContain("ellipse");
    expect(vertices[1]?.style).toContain("rhombus");
    expect(vertices[0]?.x).not.toBe(vertices[1]?.x);
    expect(edges[0]).toMatchObject({
      source: "n:start",
      target: "n:check",
      value: "next",
    });
    expect(edges[1]?.style).toContain("dashed=1");
  });
});

describe("C4 draw.io", () => {
  it("draws each node at its ELK/libavoid box, boundaries first, with relationships as connectors", () => {
    const cells = drawioCells(c4ToDrawio(c4));
    const vertices = cells.filter((cell) => cell.vertex);
    const edges = cells.filter((cell) => cell.edge);

    // The boundary (has children) draws before its leaf so the leaf sits on top.
    expect(vertices.map((cell) => cell.value)).toEqual([
      "Billing System",
      "Customer",
      "Billing Service",
    ]);
    expect(
      vertices.find((cell) => cell.value === "Billing Service"),
    ).toMatchObject({ x: 320, y: 40, width: 200, height: 100 });
    expect(edges).toEqual([
      expect.objectContaining({
        value: "Uses",
        source: "n:person",
        target: "n:system",
      }),
      expect.objectContaining({
        value: "Routes to",
        source: "n:system",
        target: "n:service",
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// XMind — validated against its own tree schema
// ---------------------------------------------------------------------------

type XmindTopic = {
  id: string;
  title: string;
  children?: { attached: XmindTopic[] };
};

const xmindTopicSchema: z.ZodType<XmindTopic> = z.lazy(() =>
  z.object({
    id: z.string(),
    title: z.string(),
    children: z.object({ attached: z.array(xmindTopicSchema) }).optional(),
  }),
);

const xmindSheetSchema = z.array(
  z.object({
    id: z.string(),
    class: z.literal("sheet"),
    title: z.string(),
    rootTopic: xmindTopicSchema,
  }),
);

function parseXmind(bytes: Uint8Array) {
  const files = unzipStore(bytes);
  expect(files.get("manifest.json")).toBeTruthy();
  expect(files.get("metadata.json")).toBeTruthy();

  return xmindSheetSchema.parse(
    JSON.parse(files.get("content.json") ?? "null"),
  );
}

describe("diagramExportFilename", () => {
  it("slugifies the title", () => {
    expect(diagramExportFilename("Auth flow!", "mmd")).toBe("auth-flow.mmd");
  });
});

describe("sequence xmind", () => {
  it("round-trips an actor → steps tree through the zip/json", () => {
    const [sheet] = parseXmind(sequenceToXmind(sequence));
    expect(sheet?.title).toBe("Login");

    const actors = sheet?.rootTopic.children?.attached ?? [];
    expect(actors.map((topic) => topic.title)).toEqual(["Client", "Server"]);
    expect(actors[0]?.children?.attached.map((topic) => topic.title)).toEqual([
      "POST /login → Server",
      "cache token → Client",
    ]);
    expect(actors[1]?.children?.attached.map((topic) => topic.title)).toEqual([
      "200 OK → Client",
    ]);
  });
});

describe("flow xmind", () => {
  it("round-trips the node hierarchy through the zip/json", () => {
    const [sheet] = parseXmind(flowToXmind(flow));
    expect(sheet?.rootTopic.title).toBe("Auth flow");

    const roots = sheet?.rootTopic.children?.attached ?? [];
    expect(roots.map((topic) => topic.title)).toEqual(["Start"]);
    expect(roots[0]?.children?.attached[0]?.title).toBe("Token valid?");
    expect(roots[0]?.children?.attached[0]?.children?.attached[0]?.title).toBe(
      "Allow",
    );
  });
});

describe("C4 xmind", () => {
  it("round-trips the expand hierarchy (boundary → children) through the zip/json", () => {
    const [sheet] = parseXmind(c4ToXmind(c4));
    expect(sheet?.title).toBe("Billing context");

    const roots = sheet?.rootTopic.children?.attached ?? [];
    expect(roots.map((topic) => topic.title)).toEqual([
      "Customer",
      "Billing System",
    ]);

    const system = roots.find((topic) => topic.title === "Billing System");
    expect(system?.children?.attached.map((topic) => topic.title)).toEqual([
      "Billing Service",
    ]);
  });
});
