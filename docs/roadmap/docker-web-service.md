# Roadmap: Whiteboard as a local Docker web service

Goal: run Whiteboard in a Docker container on your own machine. Open
`http://localhost:3000` in any browser to read a review's summary and diagrams,
select text or a diagram node with the mouse or keyboard, and send the
selection to an agent. No Electron, no vendored Code-OSS, no editor or
line-diff panes.

Why and what the plan rests on: [the blueprint audit](../audits/minimalist-docker-blueprint.md).

Each section below is one GitHub issue (number in the heading). The first section is the epic; the rest
are its sub-issues, in build order. Each has an implementation plan,
acceptance criteria and a definition of done.

---

## Epic: Run Whiteboard as a local Docker web service (#2)

### Why this is mostly wiring

- `whiteboard server start` already runs the full review API without Desktop
  (`packages/review/src/server/headless-host.ts`).
- The canvas is already a React + Vite app that reads everything over HTTP
  (`packages/review/app/src/host/review-client.ts`).
- A non-VS Code `ReviewCanvasBridge` already exists for browser tests
  (`packages/review/app/src/fixture-review-bridge.ts`).
- Send-to-agent already exists as Ask (`packages/review/src/ask/`); the
  headless host just doesn't enable it.

### Scope

In scope: headless server changes, a web build of the canvas, Ask in headless
mode, a Docker image, a compose file, docs and a CI smoke test.

Out of scope for this epic: hosted or multi-tenant deployment, Vercel/Netlify,
Cloudflare Durable Objects / pi-durable, and deleting `apps/review-desktop` or
`diffr` from the repository. Desktop keeps working unchanged.

### Sub-issues

1. Let the headless server listen on a non-loopback address
2. Add a browser entry and bridge for the review canvas
3. Serve the web canvas from the headless server
4. Trim the web canvas to summary, diagrams and Ask
5. Enable Ask (send to agent) in the headless server
6. Docker image and compose file
7. CI: build the image and smoke-test it in a browser

### Definition of done

- [ ] All sub-issues closed.
- [ ] `docker compose up` on a clean machine, with a repository mounted, serves
      the canvas at `http://localhost:3000`.
- [ ] An agent inside the container authors a review through `whiteboard mcp`
      or `whiteboard api`, and the browser shows it live.
- [ ] Selecting text or a diagram node and pressing the Ask shortcut sends it
      to the agent, and the answer streams back into the page.
- [ ] `pnpm ci` passes and the Desktop build is unchanged.
- [ ] Docs cover running it, auth, and limits.

---

## 1. Let the headless server listen on a non-loopback address (#3)

### Context

`runHeadlessServer` always binds `127.0.0.1` (`headless-host.ts`), and the
`--port` help text says "loopback port". Inside a container, loopback is not
reachable from the host, so Docker port publishing does nothing.

### Implementation plan

1. Add `host?: string` to `HeadlessServerInput`; pass it to `server.listen`,
   defaulting to `127.0.0.1`.
2. Add `--host <address>` to `whiteboard server start` in
   `packages/review/src/cli-runner.ts`, plus a `WHITEBOARD_HOST` env fallback.
   Update the `--port` help text.
3. Keep the discovery file's `url` usable by local clients: when bound to
   `0.0.0.0` or `::`, write `http://127.0.0.1:<port>` there.
4. Print a one-line warning on stderr when bound to a non-loopback address,
   saying the token is the only protection.
5. Keep token auth mandatory on every route; no unauthenticated mode.

### Acceptance criteria

- [ ] `whiteboard server start --host 0.0.0.0 --port 3000` accepts connections
      on all interfaces.
- [ ] Without `--host`, behavior is identical to today.
- [ ] Requests without the token get 401 regardless of bind address.
- [ ] `whiteboard api` and `whiteboard mcp` on the same machine still find the
      server through the discovery file.

### Definition of done

- [ ] Code merged with a behavior test in `headless-host.test.ts` that binds a
      non-loopback address and checks auth (no change-detector tests).
- [ ] CLI help and `packages/review/README.md` mention `--host`.
- [ ] `pnpm lint`, `pnpm typecheck` and the review package tests pass.

---

## 2. Add a browser entry and bridge for the review canvas (#4)

### Context

The canvas is built only as a library for the VS Code workbench
(`app/desktop.vite.config.ts`, entry `app/src/desktop-entry.tsx`,
`mountReviewCanvas`). The workbench provides a `ReviewCanvasBridge`
(`packages/review-protocol/src/contracts.ts:318`) with Monaco diff views,
inline editors, theme, tooltips and verbs (`reveal`, `openDiff`). A plain
browser has none of these.

### Implementation plan

1. Add `app/src/web/web-bridge.ts`: a `ReviewCanvasBridge` where
   - `request` is `fetch` with the `x-review-token` header (reuse
     `reviewFetchUrl` from `host/review-client.ts`);
   - `config` comes from the page (server URL = `location.origin`, token from
     the URL fragment, then kept in `sessionStorage`; see issue 3);
   - `currentTheme`/`onDidChangeTheme` follow `prefers-color-scheme`;
   - `diffView` and `inlineEditors` return a small read-only placeholder
     (or nothing, see issue 4);
   - `post` handles verbs the web needs and returns `{ ok: false }` with a
     clear message for editor verbs like `reveal` and `openDiff`;
   - `notify`, `setupTooltip` and `reportDiagnostic` use simple DOM versions.
   Start from `fixture-review-bridge.ts`, which already mounts the JSON canvas
   without a workbench.
2. Add `app/src/web/web-entry.tsx` with an `index.html` that mounts Home (the
   review list) at `/` and `ApiCanvas` at `/r/:reviewId`, using
   `mountReviewCanvas`.
3. Add `app/web.vite.config.ts` that shares plugins with the desktop config
   (StyleX, libavoid hardening, KaTeX) and outputs `dist/web` with an HTML
   entry. Serve `libavoid.wasm` as an asset and pass its URL as `wasmUrl`.
4. Add a `build:web` script to `@dev.fast/review-canvas`.

### Acceptance criteria

- [ ] `pnpm --filter @dev.fast/review-canvas build:web` produces `dist/web`
      with `index.html`.
- [ ] Pointing that page at a running headless server lists reviews and opens
      one, with markdown, flow, sequence and database diagrams rendering.
- [ ] Light and dark themes both work.
- [ ] No VS Code or Monaco code ends up in the web bundle.
- [ ] The desktop build output is unchanged.

### Definition of done

- [ ] A browser test mounts the web entry against `fixtureReviewBridge`-style
      fixtures and checks a diagram renders and a review opens from Home.
- [ ] `pnpm --filter @dev.fast/review-canvas test` and typecheck pass.
- [ ] `packages/review/app/README.md` documents `build:web`.

---

## 3. Serve the web canvas from the headless server (#5)

Depends on 1 and 2.

### Context

The headless host only mounts `/reviews-api`. The web canvas needs to be served
from the same origin so the browser can call the API without CORS.

### Implementation plan

1. Add `--web <dir>` (env `WHITEBOARD_WEB_DIR`) to `whiteboard server start`.
   When set, the Hono app serves static files from that directory and falls
   back to `index.html` for `/` and `/r/*`.
2. Keep `/reviews-api` token-protected. Static files are public; they contain
   no data.
3. On startup print the open URL with the token in the fragment, for example
   `http://localhost:3000/#token=…`, the way Jupyter does. The fragment never
   reaches the server logs.
4. Add `--token <value>` (env `WHITEBOARD_TOKEN`) so Docker users can pin a
   token instead of reading it from logs. Reject tokens shorter than 32
   characters.
5. Set `Cache-Control` for hashed assets and `no-store` for `index.html`; set a
   CSP that allows only same-origin scripts and the wasm asset.

### Acceptance criteria

- [ ] `whiteboard server start --web packages/review/app/dist/web --port 3000`
      then opening the printed URL shows Home.
- [ ] Reloading `/r/<id>` works (SPA fallback).
- [ ] Opening the page without a token shows a short "paste your token"
      screen, not a blank page or a stack trace.
- [ ] API calls without a token still return 401.

### Definition of done

- [ ] Behavior tests for static serving, SPA fallback and token-in-fragment
      bootstrap.
- [ ] README section for `--web` and `--token`.
- [ ] Lint, typecheck and tests pass.

---

## 4. Trim the web canvas to summary, diagrams and Ask (#6)

Depends on 2.

### Context

The goal is a minimal view: summary and flow diagrams, keyboard and mouse
selection, and send-to-agent. Desktop surfaces such as the Diff view, code
peeks that open editors, the source tree, the commits view, the install and
welcome screens and Settings don't apply in the browser.

### Implementation plan

1. Add a `surface: "web"` capability to `ReviewRuntimeConfig` (or to the
   bridge), defaulting to the desktop behavior.
2. In the canvas, hide the Diff tab, the source tree toggle, Commits, the
   install/welcome flows and Settings when `surface === "web"`.
3. Render code peeks read-only from the API's file content, without the
   "open in editor" action.
4. Keep the keyboard model: navigation, Find, text and node selection, and the
   Ask shortcut. List the shortcuts in a `?` help overlay.
5. Make "Copy agent context" (`copy-agent-context.ts`) work in the browser as
   a fallback when Ask isn't configured.

### Acceptance criteria

- [ ] In web mode, no control opens an editor, diff or install flow.
- [ ] Every block type in `packages/review/src/review-api/blocks` either
      renders or shows a clear "not available in web" note; none crash.
- [ ] Text and diagram-node selection plus the Ask shortcut work with keyboard
      only.
- [ ] Desktop shows every surface it shows today.

### Definition of done

- [ ] Browser tests for the hidden surfaces and the keyboard selection to Ask
      path in web mode.
- [ ] Shortcuts documented in the web help overlay.
- [ ] Lint, typecheck and tests pass.

---

## 5. Enable Ask (send to agent) in the headless server (#7)

Depends on 1.

### Context

`createWhiteboardCore` accepts `ask: { tools }`
(`packages/review/src/server/review-server-core.ts:127`), and Desktop passes it
(`desktop-server.ts`, `askTools`). The headless host doesn't, so Ask is missing
in headless mode. Ask launches the user's own agent CLI (Claude Code, Codex,
Pi) over ACP (`packages/review/src/ask/agents.ts`).

### Implementation plan

1. Build `AskTools` in `headless-host.ts` the same way Desktop does: give Ask
   sessions `whiteboard mcp` as an MCP server and `whiteboard api` as the CLI
   fallback, both pointed at this server's state directory.
2. Add `--ask` / `--no-ask` (env `WHITEBOARD_ASK`), default on when at least
   one agent is detected.
3. Agent credentials come from the environment the server runs in (for
   example `ANTHROPIC_API_KEY`, or a mounted `~/.claude`). Don't store keys in
   the review store.
4. Keep Ask sessions in the agent's read-only mode where it has one, as
   Desktop does.
5. Close Ask threads on server shutdown (`core.close()`).

### Acceptance criteria

- [ ] With Claude Code installed and authenticated, the web canvas lists it in
      the Ask agent picker.
- [ ] Asking about a selection returns a streamed answer, and an agent that
      edits the review shows the change live.
- [ ] With no agent installed, the Ask panel says so and links to the docs,
      instead of failing silently.
- [ ] Stopping the server stops the agent processes.

### Definition of done

- [ ] Behavior test that a headless server with a stub ACP agent completes one
      Ask turn.
- [ ] Docs list the supported agents and the env vars or mounts each needs.
- [ ] Lint, typecheck and tests pass.

---

## 6. Docker image and compose file (#8)

Depends on 1, 3 and 5.

### Context

This is the deliverable users run. Reviews pin to a local checkout (the
`repositories` table stores local paths), so the container must see the
repository being reviewed.

### Implementation plan

1. Multi-stage `Dockerfile` at the repo root (or `docker/`):
   - build stage: Node 24, pnpm, `pnpm install --filter` for
     `@dev.fast/whiteboard` and `@dev.fast/review-canvas` only, build the CLI
     and `dist/web`. Skip `apps/review-desktop` and the Rust build; use the
     published `@dev.fast/diffr-linux-*` binary.
   - runtime stage: Node 24 slim, `git`, the built CLI and web assets, an
     optional agent CLI layer (`ARG AGENT=claude|codex|none`). Run as a
     non-root user.
2. Entry point:
   `whiteboard server start --host 0.0.0.0 --port 3000 --web /app/web --state-dir /data`.
3. `docker-compose.yml`: publish `127.0.0.1:3000:3000` (loopback on the host by
   default), a named volume for `/data`, the repository mounted at
   `/workspace`, and `WHITEBOARD_TOKEN` and agent keys from `.env`.
4. A `HEALTHCHECK` against an unauthenticated `/healthz` route (add it in
   issue 3 if missing).
5. A `.dockerignore` that drops `apps/review-desktop`, `diffr/` sources,
   `node_modules` and `.git`.
6. `docs/docker.md`: run, mount a repo, set the token, connect an agent from
   the host to the container's MCP, upgrade, and known limits.

### Acceptance criteria

- [ ] `docker compose up --build` on a clean Linux or macOS machine serves the
      canvas at `http://localhost:3000`.
- [ ] Reviews survive `docker compose down && docker compose up`.
- [ ] The image is linux/amd64 and linux/arm64, and under 500 MB without an
      agent CLI.
- [ ] The container runs as a non-root user and needs no extra privileges.
- [ ] A review authored by an agent against `/workspace` shows code peeks
      from that checkout.

### Definition of done

- [ ] Dockerfile, compose file, `.dockerignore` and `docs/docker.md` merged.
- [ ] Image builds in CI (issue 7).
- [ ] Manual check on at least one machine, recorded in the PR.

---

## 7. CI: build the image and smoke-test it in a browser (#9)

Depends on 6.

### Implementation plan

1. Add `.github/workflows/docker-web.yml`, triggered on PRs that touch
   `packages/review/**`, `packages/review-protocol/**`, `Dockerfile` or
   `docker-compose.yml`.
2. Build the image with Buildx and cache layers.
3. Start it with a fixed test token and a small fixture repository mounted.
4. Seed one review with `whiteboard api` (markdown, flow diagram and sequence
   blocks).
5. Run a Playwright check that opens the page with the token, opens the
   review, and sees the diagram render. Ask is not exercised in CI (it needs
   real agent credentials).
6. Publishing the image to a registry is a separate follow-up.

### Acceptance criteria

- [ ] The workflow fails when the page doesn't render the seeded review.
- [ ] The workflow passes on the PR that adds it.
- [ ] It doesn't run on PRs that only touch Desktop or `diffr`.

### Definition of done

- [ ] Workflow merged and green on `main`.
- [ ] Failure output includes the container logs and a screenshot.
