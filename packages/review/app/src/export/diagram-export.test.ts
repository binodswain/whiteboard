import { describe, expect, it } from "vitest";
import { z } from "zod";

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
  unzipStore,
  xmlEscape,
} from "./diagram-export.js";

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

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function parseMermaidSequence(source: string) {
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("%%"));

  if (lines[0] !== "sequenceDiagram")
    throw new Error(`expected sequenceDiagram, got ${lines[0]}`);
  const participants: { id: string; label: string }[] = [];

  const messages: { from: string; to: string; arrow: string; label: string }[] =
    [];

  for (const line of lines.slice(1)) {
    const participant = /^participant\s+(\S+|"[^"]+")(?:\s+as\s+(.+))?$/.exec(
      line,
    );

    if (participant) {
      const id = unquote(participant[1]!);
      participants.push({ id, label: participant[2] ?? id });
      continue;
    }

    const message =
      /^("[^"]+"|[A-Za-z]\w*)(-->>|->>\+|->|->>)("[^"]+"|[A-Za-z]\w*):\s*(.*)$/.exec(
        line,
      );

    if (message) {
      messages.push({
        from: unquote(message[1]!),
        to: unquote(message[3]!),
        arrow: message[2]!,
        label: message[4]!,
      });
      continue;
    }

    throw new Error(`unparsed mermaid sequence line: ${line}`);
  }

  return { participants, messages };
}

function parseMermaidFlowchart(source: string) {
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("%%"));

  const header = /^flowchart\s+(LR|TD)$/.exec(lines[0] ?? "");

  if (!header) throw new Error(`expected flowchart, got ${lines[0]}`);
  const nodes: { id: string; kind: string; label: string }[] = [];

  const edges: { from: string; arrow: string; label?: string; to: string }[] =
    [];

  for (const line of lines.slice(1)) {
    const stadium = /^(\S+|"[^"]+")\(\[(.*)\]\)$/.exec(line);

    if (stadium) {
      nodes.push({
        id: unquote(stadium[1]!),
        kind: "terminal",
        label: unquote(stadium[2]!),
      });
      continue;
    }

    const diamond = /^(\S+|"[^"]+")\{(.*)\}$/.exec(line);

    if (diamond) {
      nodes.push({
        id: unquote(diamond[1]!),
        kind: "decision",
        label: unquote(diamond[2]!),
      });
      continue;
    }

    const box = /^(\S+|"[^"]+")\[(.*)\]$/.exec(line);

    if (box) {
      nodes.push({
        id: unquote(box[1]!),
        kind: "process",
        label: unquote(box[2]!),
      });
      continue;
    }

    const edge = /^(\S+|"[^"]+")(-\.->|-->)(?:\|([^|]*)\|)?(\S+|"[^"]+")$/.exec(
      line,
    );

    if (edge) {
      edges.push({
        from: unquote(edge[1]!),
        arrow: edge[2]!,
        label: edge[3],
        to: unquote(edge[4]!),
      });
      continue;
    }

    throw new Error(`unparsed mermaid flowchart line: ${line}`);
  }

  return { direction: header[1], nodes, edges };
}

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

function xmlUnescape(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseDrawio(xml: string) {
  if (!xml.includes("<mxfile") || !xml.includes("<mxGraphModel"))
    throw new Error("not an mxfile");

  const cells: {
    id: string;
    value: string;
    style: string;
    vertex: boolean;
    edge: boolean;
    source?: string;
    target?: string;
    x?: number;
    y?: number;
  }[] = [];

  const tag = /<mxCell\b([^>]*?)\s*(?:\/>|>([\s\S]*?)<\/mxCell>)/g;

  for (const match of xml.matchAll(tag)) {
    const attrs = match[1] ?? "";

    const attr = (name: string) => {
      const found = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);

      return found ? xmlUnescape(found[1]!) : undefined;
    };

    const body = match[2] ?? "";
    const geometry = /<mxGeometry\b([^>]*)/.exec(body);

    const geo = (name: string) => {
      if (!geometry) return undefined;
      const found = new RegExp(`\\b${name}="([^"]*)"`).exec(geometry[1] ?? "");

      return found ? Number(found[1]) : undefined;
    };

    cells.push({
      id: attr("id") ?? "",
      value: attr("value") ?? "",
      style: attr("style") ?? "",
      vertex: attr("vertex") === "1",
      edge: attr("edge") === "1",
      source: attr("source"),
      target: attr("target"),
      x: geo("x"),
      y: geo("y"),
    });
  }

  return cells.filter((cell) => cell.id !== "0" && cell.id !== "1");
}

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

describe("sequence mermaid", () => {
  it("round-trips actors, arrows and labels through a mermaid parse", () => {
    const parsed = parseMermaidSequence(sequenceToMermaid(sequence));
    expect(parsed.participants).toEqual([
      { id: "client", label: "Client" },
      { id: "server", label: "Server" },
    ]);
    expect(parsed.messages).toEqual([
      { from: "client", to: "server", arrow: "->>", label: "POST /login" },
      { from: "server", to: "client", arrow: "-->>", label: "200 OK" },
      { from: "client", to: "client", arrow: "->>+", label: "cache token" },
    ]);
  });

  it("escapes mermaid-reserved characters so the parse still recovers the ids", () => {
    const parsed = parseMermaidSequence(sequenceToMermaid(reservedSequence));
    expect(parsed.participants.map((participant) => participant.id)).toEqual([
      "client-api",
    ]);
    expect(parsed.messages[0]).toMatchObject({
      from: "client-api",
      to: "client-api",
    });
    expect(parsed.messages[0]?.label).not.toMatch(/[#;]/);
  });
});

describe("flow mermaid", () => {
  it("round-trips nodes, kinds and edges through a mermaid parse", () => {
    const parsed = parseMermaidFlowchart(flowToMermaid(flow));
    expect(parsed.direction).toBe("LR");
    expect(parsed.nodes).toEqual([
      { id: "start", kind: "terminal", label: "Start" },
      { id: "check", kind: "decision", label: "Token valid?" },
      { id: "ok", kind: "process", label: "Allow" },
    ]);
    expect(parsed.edges).toEqual([
      { from: "start", arrow: "-->", label: "next", to: "check" },
      { from: "check", arrow: "-.->", label: "yes", to: "ok" },
    ]);
  });

  it("quotes ids and labels that mermaid would otherwise comment out", () => {
    const parsed = parseMermaidFlowchart(flowToMermaid(reservedFlow));
    expect(parsed.nodes.map((node) => node.id)).toEqual(["a-1", "end"]);
    expect(parsed.edges[0]).toMatchObject({ from: "a-1", to: "end" });
  });
});

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

describe("sequence draw.io", () => {
  it("round-trips lifelines and message styles through mxGraph XML", () => {
    const cells = parseDrawio(sequenceToDrawio(sequence));
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
    const cells = parseDrawio(sequenceToDrawio(reservedSequence));
    expect(cells.find((cell) => cell.vertex)?.value).toBe("Client & Co <v1>");
    expect(xmlEscape("Client & Co <v1>")).toContain("&amp;");
  });
});

describe("flow draw.io", () => {
  it("round-trips ELK positions and connectors through mxGraph XML", async () => {
    const cells = parseDrawio(await flowToDrawio(flow));
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
