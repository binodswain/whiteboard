# Blueprint audit: "Minimalist Whiteboard Docker Service"

Checked against this repository at `8a53054` (2026-10-08). Source: "Minimalist Whiteboard Docker Service Blueprint.pdf". The PDF is an exported Gemini chat; it was written against `devdotfast/whiteboard` without reading the code, so many of its specifics are guesses.

## Verdict

| Stage in the PDF | Feasible? | Effort |
| --- | --- | --- |
| 1. Local Docker web service (summary + diagrams + select → send to agent) | **Yes.** Most of the pieces already exist. | Small to medium |
| 2. Hosted multi-tenant PR preview platform on Vercel/Netlify | **Partly.** The static viewer could go there; the server cannot. | Large |
| 3. Cloud agent on Cloudflare Durable Objects + pi-durable | **Not as a port.** It is a rewrite of the authoring engine. | Very large, experimental |

## What the PDF gets wrong about the repo

| PDF claim | What the repo actually has |
| --- | --- |
| `packages/canvas` is a Mermaid renderer | No such package and no Mermaid anywhere. Diagrams are native React blocks (`flow_diagram`, `sequence`, `database_lens`, `software_map`, `call_stack_diff`) drawn with `@xyflow/react` + `elkjs` in `packages/review/app` (`@dev.fast/review-canvas`). |
| `packages/diffr` is a Rust/WASM summarizer | It lives at the root as `diffr/` (147 MB incl. Rust crates). The server uses prebuilt native npm binaries (`@dev.fast/diffr-linux-x64` etc.) plus WASM plugins. |
| `packages/mcp` and `packages/sdk` | Neither exists. MCP is a subcommand (`whiteboard mcp`, `src/review-api/mcp.ts`) and authoring goes through the JSON API at `/reviews-api`. |
| `.agents/plugins` holds CLI scripts | Real, but agent plugins also live in `packages/agent-plugins`. |
| "Keep the React app, put it on Vite" | It is already a React 19 + Vite app. The catch is that it is mounted inside the VS Code workbench through a `ReviewCanvasBridge` (`packages/review-protocol/src/contracts.ts:318`), which supplies Monaco diff views, inline editors, theming and verbs. |
| "Send to Agent" needs to be built | Already built: the Ask panel (`app/src/ask-*.tsx`, `src/ask/`) runs the user's own Claude Code / Codex / Pi CLI over ACP. |
| Backend needs Node or Go on port 8080 | A Node backend already exists: `whiteboard server` (`src/server/headless-host.ts`), Hono, token auth, SQLite via `node:sqlite`. |

## Stage 1: local Docker service. Feasible.

What exists today:
- `whiteboard server` runs without Desktop and serves the full review API. It binds `127.0.0.1` only (`headless-host.ts`), so a container needs a bind-address option.
- The canvas already fetches everything over HTTP (`app/src/host/review-client.ts`), and there is a non-VS Code bridge used by browser tests (`app/src/fixture-review-bridge.ts`). That is the template for a browser bridge.

Work needed:
1. A browser entry (next to `app/src/desktop-entry.tsx`) with a `ReviewCanvasBridge` that implements `request` with fetch + token and stubs or hides `diffView` / `inlineEditors` (that is how you "drop the diff and editor").
2. Serve the built canvas as static files from the headless server, and add a `--host 0.0.0.0` option.
3. Wire Ask into the headless host. `createWhiteboardCore` accepts `ask` (`review-server-core.ts:127`) but the headless host never passes it, so today Send-to-agent only works in Desktop.
4. Dockerfile: Node 24, git, the agent CLI you want (e.g. `claude`), and the repo mounted as a volume. Reviews are pinned to a local checkout (`repositories` table stores local paths), so the container must see the repo.

What you can drop: `apps/review-desktop` (98 MB, Electron + vendored Code-OSS) is not needed. I'd keep `diffr` as the published Linux binary rather than ripping it out, because the server core imports it and removing it means touching review storage and lenses.

## Stage 2: hosted PR preview platform. Partly feasible.

- The server needs a filesystem, `git`, `gh`, SQLite and native binaries (`src/review-api/pull-request.ts` shells out to `git` and `gh`). That rules out Vercel/Netlify functions. It fits a long-running container host (Fly, Railway, a VM, Kubernetes).
- There is already a sharing path: `packages/review-share-protocol` ("portable immutable review sharing envelope") and `src/sharing/` publish to a hosted store (`app.dev.fast/s/<id>#capability`). A read-only viewer on a static host fed by those envelopes is the cheapest route to "a URL per review". The README notes shared reviews don't update after sharing.
- `CONTEXT.md` already names "headless authoring from a CI job" as a goal, and the CLI release workflow tests the headless host and headless sharing. The PDF's CI step (POST a JSON with `summary` + Mermaid strings) does not match the real API; CI would run an agent against `whiteboard server` and then share.
- Missing for multi-tenant: per-repo auth, tenancy, a list-of-reviews dashboard over many repos. The server is single-user with one token.

## Stage 3: Durable Objects + pi-durable. Not a realistic port.

- pi-durable is real but experimental (Pi 1.0 shipped it as "experimental Pi Durable"; Cloudflare documents a Pi harness under Agents). I did not verify the exact API in the PDF's code sample; `claude-3-5-sonnet` there is an outdated model id.
- Whiteboard's authoring needs a checkout on disk (`checkout-fs.ts`, `worktree-source.ts`), `git`, native `diffr` and `node:sqlite`. None of that runs in a Worker. Replacing them with GitHub API tools (as the PDF suggests) means rewriting code peeks, lenses, semantic diff and source pins, which is most of what makes Whiteboard different.
- If cloud agents are the goal, a container per job (GitHub Actions runner, Fly Machine, Cloudflare Containers) running the existing `whiteboard server` + agent CLI keeps the code as is.

## Recommendation

Build Stage 1 first. It is a few focused changes (browser bridge, static serving, bind address, Ask in headless, Dockerfile) on top of code that exists. For hosting, run the same container on a container host and use the existing share envelopes for public links, instead of the Vercel + Durable Objects design.

The build plan for Stage 1 is in [docs/roadmap/docker-web-service.md](../roadmap/docker-web-service.md).
