import { CopyIcon, copyText } from "@canvas/copy-text";
import { homeStyles } from "@canvas/home-styles";
import { reviewFetchUrl } from "@canvas/host/review-client";
import { DrawnCheckIcon } from "@canvas/icons";
import { promptStyles } from "@canvas/prompt-styles";
import {
  elevation,
  fontSize,
  fontWeight,
  layer,
  radius,
} from "@canvas/scale.stylex";
import { withClass } from "@canvas/stylex-props";
import { themeStyles } from "@canvas/theme-styles";
import { tokens } from "@canvas/tokens.stylex";
import { Button } from "@canvas/ui/button";
import { EmptyState } from "@canvas/ui/empty-state";
import { textStyles } from "@canvas/ui/text";
import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";

const setupInfoSchema = z.object({
  serverUrl: z.string(),
  codeRoot: z.string().nullable(),
  localAuth: z.boolean(),
  token: z.string().optional(),
  version: z.string(),
  healthy: z.boolean(),
});

export type SetupInfo = z.infer<typeof setupInfoSchema>;

export interface WebSetupOptions {
  /** Defaults to the page origin: the web bundle is served by the review server. */
  serverUrl?: string;
  /** The token the canvas already resolved; passed through to the request. */
  token?: string;
  /** Test seam: the request function the web canvas shares. */
  request?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface WebSetupHandle {
  dispose(): void;
}

/** The MCP reads the server's own URL; only a non-default one is spelled out. */
const DEFAULT_SERVER_URL = "http://localhost:7421";

const COPIED_RESET_MS = 2000;

/**
 * The /setup landing page: the commands a host-side agent needs to register
 * Whiteboard's MCP. Rendered by the web bundle but outside the review canvas
 * — it is reachable before any token exists.
 */
export function SetupView({
  serverUrl,
  request,
}: {
  serverUrl: string;
  request: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; info: SetupInfo }
  >({ status: "loading" });

  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    const load = async () => {
      try {
        const response = await request(`${serverUrl}/setup-info`);

        if (!response.ok)
          throw new Error(
            `Could not read the server's setup information (${response.status}).`,
          );

        const info = setupInfoSchema.parse(await response.json());

        if (!cancelled) setState({ status: "ready", info });
      } catch (cause) {
        if (!cancelled)
          setState({
            status: "error",
            message:
              cause instanceof Error
                ? cause.message
                : "Could not read setup info.",
          });
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [serverUrl, request, reload]);

  return (
    <main {...withClass("review-home", homeStyles.page)}>
      <div {...stylex.props(homeStyles.scroll)}>
        <div {...stylex.props(homeStyles.content, styles.content)}>
          <div {...stylex.props(styles.header)}>
            <span {...stylex.props(textStyles.eyebrow, styles.kicker)}>
              Whiteboard setup
            </span>
            <h1 {...stylex.props(homeStyles.heading)}>Connect your agent</h1>
            {state.status === "ready" ? (
              <p {...stylex.props(styles.sub)}>
                Whiteboard serves this canvas from{" "}
                <code {...stylex.props(styles.code)}>
                  {state.info.serverUrl}
                </code>{" "}
                — healthy, v{state.info.version}.
                {state.info.localAuth
                  ? " Local auth is on, so no token is needed."
                  : ""}
              </p>
            ) : (
              <p {...stylex.props(styles.sub)}>
                Your coding agent talks to this server over MCP.
              </p>
            )}
          </div>
          {state.status === "loading" ? (
            <p role="status" {...stylex.props(styles.sub)}>
              Loading setup information…
            </p>
          ) : null}
          {state.status === "error" ? (
            <EmptyState
              role="alert"
              message={state.message}
              action={
                <Button onClick={() => setReload((tick) => tick + 1)}>
                  Retry
                </Button>
              }
            />
          ) : null}
          {state.status === "ready" ? <SetupSteps info={state.info} /> : null}
          <p {...stylex.props(styles.footer)}>
            <a {...stylex.props(styles.homeLink)} href="/">
              Back to sessions
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}

function SetupSteps({ info }: { info: SetupInfo }) {
  const env: [string, string][] = [];

  if (info.serverUrl !== DEFAULT_SERVER_URL)
    env.push(["WHITEBOARD_URL", info.serverUrl]);

  if (!info.localAuth) env.push(["WHITEBOARD_TOKEN", info.token ?? "<token>"]);

  const claude = [
    "claude mcp add whiteboard",
    ...env.map(([name, value]) => `-e ${name}=${value}`),
    "-- npx -y @dev.fast/whiteboard mcp",
  ].join(" ");

  const codex = [
    "[mcp_servers.whiteboard]",
    'command = "npx"',
    'args = ["-y", "@dev.fast/whiteboard", "mcp"]',
    ...(env.length
      ? [
          "",
          "[mcp_servers.whiteboard.env]",
          ...env.map(([name, value]) => `${name} = "${value}"`),
        ]
      : []),
  ].join("\n");

  return (
    <ol {...stylex.props(styles.steps)}>
      <li {...stylex.props(styles.step)}>
        <h2 {...stylex.props(styles.stepTitle)}>Claude Code</h2>
        <CopyBlock
          label="Claude Code command"
          text={claude}
          note={
            info.localAuth || info.token ? undefined : (
              <>
                Replace{" "}
                <code {...stylex.props(styles.code)}>&lt;token&gt;</code> with
                the server token from{" "}
                <code {...stylex.props(styles.code)}>
                  docker compose logs whiteboard
                </code>
                .
              </>
            )
          }
        />
      </li>
      <li {...stylex.props(styles.step)}>
        <h2 {...stylex.props(styles.stepTitle)}>Codex</h2>
        <p {...stylex.props(styles.note)}>
          Add to{" "}
          <code {...stylex.props(styles.code)}>~/.codex/config.toml</code>:
        </p>
        <CopyBlock label="Codex config" text={codex} />
      </li>
      <li {...stylex.props(styles.step)}>
        <h2 {...stylex.props(styles.stepTitle)}>Run inside your code</h2>
        <p {...stylex.props(styles.note)}>
          {info.codeRoot ? (
            <>
              The server mounts{" "}
              <code {...stylex.props(styles.code)}>{info.codeRoot}</code> —
              launch your agent inside a repository under it, or the container
              cannot see the checkout.
            </>
          ) : (
            <>
              Launch your agent inside a repository under the directory mounted
              into the container — the server only sees that tree.
            </>
          )}
        </p>
      </li>
    </ol>
  );
}

/** A quoted command or config with a copy action, in the prompt card's style. */
function CopyBlock({
  label,
  text,
  note,
}: {
  label: string;
  text: string;
  note?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_RESET_MS);
    });
  };

  return (
    <>
      <pre {...stylex.props(promptStyles.body)}>{text}</pre>
      {note ? <p {...stylex.props(styles.note)}>{note}</p> : null}
      <div {...stylex.props(promptStyles.actions)}>
        <button
          type="button"
          {...stylex.props(promptStyles.copy)}
          aria-live="polite"
          aria-label={`${copied ? "Copied" : "Copy"} ${label}`}
          onClick={copy}
        >
          {copied ? <DrawnCheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : `Copy ${label.toLowerCase()}`}
        </button>
      </div>
    </>
  );
}

/** The floating link Home shows toward /setup. */
export function SetupLink() {
  return (
    <a {...stylex.props(promptStyles.copy, styles.setupLink)} href="/setup">
      Connect your agent
    </a>
  );
}

export interface SetupLinkHandle {
  setVisible(visible: boolean): void;
  dispose(): void;
}

/**
 * A sibling of the review canvas that renders the /setup link while Home is
 * on screen. The canvas owns the theme: its `data-review-theme` is mirrored
 * onto this host so the link follows the same palette.
 */
export function mountSetupLink(container: HTMLElement): SetupLinkHandle {
  const host = container.ownerDocument.createElement("div");

  const applyTheme = () => {
    const light = container.dataset.reviewTheme === "light";

    host.className = [
      light && "review-app--theme-light",
      stylex.props(
        themeStyles.vars,
        styles.chromeHost,
        light && themeStyles.light,
      ).className,
    ]
      .filter(Boolean)
      .join(" ");
  };

  const observer = new MutationObserver(applyTheme);
  observer.observe(container, {
    attributes: true,
    attributeFilter: ["data-review-theme"],
  });
  applyTheme();
  container.appendChild(host);

  const root = createRoot(host);
  let disposed = false;
  let visible = false;

  const render = () => root.render(visible ? <SetupLink /> : null);

  render();

  return {
    setVisible(next) {
      if (disposed || next === visible) return;
      visible = next;
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      root.unmount();
      host.remove();
    },
  };
}

/**
 * Mounts /setup standalone: the review canvas is not needed for the landing
 * page, so this repeats only its theme host — the scoped stylesheet needs
 * `.review-canvas-root` and the token classes on an ancestor.
 */
export function mountWebSetup(
  container: HTMLElement,
  options: WebSetupOptions,
): WebSetupHandle {
  const serverUrl = options.serverUrl ?? location.origin;

  const request =
    options.request ??
    ((url: string, init?: RequestInit) =>
      reviewFetchUrl({ serverUrl, token: options.token ?? "" }, url, init));

  container.classList.add("review-canvas-root");
  document.title = "Setup - Whiteboard";

  const host = container.ownerDocument.createElement("div");

  const media = container.ownerDocument.defaultView?.matchMedia(
    "(prefers-color-scheme: dark)",
  );

  const applyTheme = () => {
    const light = media ? !media.matches : false;

    container.dataset.reviewTheme = light ? "light" : "dark";
    host.className = [
      light && "review-app--theme-light",
      stylex.props(
        themeStyles.vars,
        styles.chromeHost,
        light && themeStyles.light,
      ).className,
    ]
      .filter(Boolean)
      .join(" ");
  };

  applyTheme();
  container.appendChild(host);
  media?.addEventListener("change", applyTheme);

  const root = createRoot(host);
  root.render(<SetupView serverUrl={serverUrl} request={request} />);

  return {
    dispose() {
      media?.removeEventListener("change", applyTheme);
      root.unmount();
      host.remove();
      container.classList.remove("review-canvas-root");
    },
  };
}

const styles = stylex.create({
  chromeHost: {
    display: "contents",
  },
  content: {
    minHeight: "100%",
    paddingBottom: "48px",
  },
  header: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    marginBottom: "28px",
  },
  kicker: {
    color: tokens.reviewHomeMeta,
  },
  sub: {
    margin: 0,
    color: tokens.reviewHomeMeta,
    fontSize: fontSize.ui,
    lineHeight: "21px",
  },
  code: {
    fontFamily: tokens.fontMono,
    color: tokens.ink,
  },
  steps: {
    display: "flex",
    flexDirection: "column",
    gap: "24px",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  step: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    maxWidth: "720px",
  },
  stepTitle: {
    margin: 0,
    color: tokens.ink,
    fontSize: fontSize.reading,
    fontWeight: fontWeight.medium,
  },
  note: {
    margin: 0,
    color: tokens.inkMuted,
    fontSize: fontSize.body,
    lineHeight: "20px",
  },
  footer: {
    marginTop: "36px",
  },
  homeLink: {
    color: tokens.accent,
    fontSize: fontSize.body,
    textDecoration: "none",
  },
  setupLink: {
    position: "fixed",
    right: "24px",
    bottom: "24px",
    zIndex: layer.popover,
    borderRadius: radius.pill,
    boxShadow: elevation.popover,
  },
});
