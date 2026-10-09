import { randomUUID } from "node:crypto";

import { isJsonObject } from "@dev.fast/json";
import { detectLocalVcsSync } from "@dev.fast/local-vcs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AuthoringTool } from "@review/review-api/agent-client.js";
import { toolResultText } from "@review/review-api/agent-client.js";
import { authoringTools } from "@review/review-api/authoring-tools.js";
import { ReviewApiClient } from "@review/review-api/client.js";
import { callPublicTool, publicTool } from "@review/review-api/public-tools.js";
import { Hono } from "hono";

/**
 * A Streamable HTTP endpoint. Local mode keeps a session per client, with
 * idle-session cleanup. Stateless mode is selected by the deployment config.
 * serves each request on a fresh server, so any replica can answer it.
 */
export function createHttpMcpApp(input: {
  api: Hono;
  scratchpad: () => boolean;
  stateless?: boolean;
  /** Request headers the internal API client copies from the caller, so the
   * review API sees the MCP caller's identity rather than an anonymous one. */
  forwardHeaders?: string[];
}) {
  const stateless = input.stateless ?? false;
  const app = new Hono();

  const sessions = new Map<
    string,
    {
      transport: WebStandardStreamableHTTPServerTransport;
      server: Server;
      touchedAt: number;
    }
  >();

  const createServer = (callerHeaders?: Headers) => {
    const server = new Server(
      { name: "whiteboard", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } } },
    );

    // SAFETY: authoringTools emits the shared AuthoringTool contract used by stdio MCP.
    const tools = authoringTools(input.scratchpad(), false).map((tool) =>
      publicTool(tool as AuthoringTool),
    );

    const client = new ReviewApiClient(
      { serverUrl: "http://whiteboard.invalid" },
      async (url, init) => {
        const route =
          url.replace("http://whiteboard.invalid/reviews-api", "") || "/";

        const headers = new Headers(init?.headers);

        if (callerHeaders)
          for (const name of input.forwardHeaders ?? []) {
            const value = callerHeaders.get(name);

            if (value && !headers.has(name)) headers.set(name, value);
          }

        return input.api.fetch(
          new Request(`http://whiteboard.invalid${route}`, {
            ...init,
            headers,
          }),
        );
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = tools.find(({ name }) => name === request.params.name);

      if (!tool)
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unknown Whiteboard tool: ${request.params.name}`,
            },
          ],
        };
      const args = { ...(request.params.arguments ?? {}) };

      try {
        if (
          (tool.commandType === "create" ||
            tool.commandType === "set_target") &&
          isJsonObject(args.target)
        ) {
          const target = args.target;

          if (
            (target.kind === "worktree" || target.kind === "commits") &&
            !("repositoryPath" in target) &&
            !("repositoryId" in target)
          ) {
            let root: string | undefined;

            if (server.getClientCapabilities()?.roots) {
              try {
                const roots = await server.listRoots({}, { timeout: 3000 });

                const uri = roots.roots.find(({ uri }) =>
                  uri.startsWith("file://"),
                )?.uri;

                if (uri) {
                  const path = decodeURIComponent(new URL(uri).pathname);
                  root = detectLocalVcsSync(path)?.rootPath;
                }
              } catch {
                /* The error below explains the required explicit path. */
              }
            }

            if (!root)
              throw new Error(
                "Pass repositoryPath as the absolute path of the repository you are working in; no usable file:// MCP root was provided.",
              );
            args.target = { ...target, repositoryPath: root };
          }
        }

        const result = await callPublicTool(client, tool, args, extra.signal);

        return {
          content: [
            // SAFETY: callPublicTool returns JSON data or the shared plain-text wrapper.
            { type: "text", text: toolResultText(tool, result as never) },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    });

    return server;
  };

  app.all("/", async (context) => {
    if (stateless) {
      // A stateless transport serves one request, and a GET would need a stream
      // that closes with the request, so it is not offered.
      if (context.req.method === "GET")
        return new Response(null, {
          status: 405,
          headers: { Allow: "POST, DELETE" },
        });

      const server = createServer(context.req.raw.headers);

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      await server.connect(transport);

      try {
        return await transport.handleRequest(context.req.raw);
      } finally {
        await server.close();
      }
    }

    for (const [id, session] of sessions) {
      if (Date.now() - session.touchedAt > 30 * 60_000) {
        sessions.delete(id);
        await session.transport.close();
        await session.server.close();
      }
    }

    const sessionId = context.req.header("mcp-session-id");
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (sessionId && !session)
      return context.json(
        {
          jsonrpc: "2.0",
          error: { code: -32001, message: "MCP session not found or expired" },
          id: null,
        },
        404,
      );

    if (!session) {
      const server = createServer(context.req.raw.headers);
      let transport!: WebStandardStreamableHTTPServerTransport;
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized(id) {
          sessions.set(id, { transport, server, touchedAt: Date.now() });
        },
        onsessionclosed(id) {
          sessions.delete(id);
          void server.close();
        },
      });
      session = { transport, server, touchedAt: Date.now() };
      await server.connect(transport);
    } else {
      session.touchedAt = Date.now();
    }

    return session.transport.handleRequest(context.req.raw);
  });

  return app;
}
