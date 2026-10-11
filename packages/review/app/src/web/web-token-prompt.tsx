import { fontSize, fontWeight } from "@canvas/scale.stylex";
import { tokens } from "@canvas/tokens.stylex";
import { Button } from "@canvas/ui/button";
import { TextField } from "@canvas/ui/text-field";
import * as stylex from "@stylexjs/stylex";
import { type FormEvent, useState } from "react";
import { createRoot } from "react-dom/client";

import { createWebThemeHost } from "./web-theme-host";

export interface TokenPromptOptions {
  /** Hosted deployments sign in through a link instead of a pasted token. */
  signIn?: { href: string; label: string };
  onSubmit(token: string): void;
}

function TokenPrompt({ signIn, onSubmit }: TokenPromptOptions) {
  const [token, setToken] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();

    const trimmed = token.trim();

    if (trimmed) onSubmit(trimmed);
  };

  return (
    <main {...stylex.props(styles.page)}>
      <h1 {...stylex.props(styles.heading)}>Whiteboard Reviews</h1>
      <p {...stylex.props(styles.text)}>
        {signIn
          ? "Sign in to see this team's reviews. An API key from Settings also works."
          : "This canvas needs the token from your review link. Paste it below to continue."}
      </p>
      {signIn ? (
        <a
          href={`${signIn.href}?next=${encodeURIComponent(
            `${location.pathname}${location.search}`,
          )}`}
          {...stylex.props(styles.signIn)}
        >
          {signIn.label}
        </a>
      ) : null}
      <form onSubmit={submit} {...stylex.props(styles.form)}>
        <TextField
          type="password"
          placeholder={signIn ? "API key" : "Review token"}
          autoComplete="off"
          required
          value={token}
          onChange={(event) => setToken(event.target.value)}
          xstyle={styles.field}
        />
        <Button type="submit" variant="primary" size="large">
          Continue
        </Button>
      </form>
    </main>
  );
}

let current: { host: HTMLElement; unmount(): void } | undefined;

/** Shows the token / sign-in screen in `container`, replacing any earlier one. */
export function renderTokenPrompt(
  container: HTMLElement,
  options: TokenPromptOptions,
): void {
  current?.unmount();

  // The frame's page is the scope root the brand bar mirrors the theme from.
  const { host } = createWebThemeHost(container, container.ownerDocument);
  const root = createRoot(host);

  root.render(<TokenPrompt {...options} />);
  current = {
    host,
    unmount() {
      root.unmount();
      host.remove();
    },
  };
}

const styles = stylex.create({
  page: {
    display: "grid",
    placeContent: "center",
    gap: "12px",
    minHeight: "100%",
    padding: "24px",
    backgroundColor: tokens.bg,
    color: tokens.ink,
    fontFamily: tokens.chromeFont,
    fontSize: fontSize.ui,
    lineHeight: 1.5,
  },
  heading: {
    margin: 0,
    fontSize: fontSize.heading,
    fontWeight: fontWeight.semibold,
  },
  text: {
    margin: 0,
    color: tokens.inkMuted,
  },
  form: {
    display: "flex",
    gap: "8px",
  },
  field: {
    minWidth: "240px",
  },
  signIn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: tokens.chromeControlHeight,
    borderRadius: tokens.chromeControlRadius,
    backgroundColor: tokens.accent,
    color: tokens.onAccent,
    fontWeight: fontWeight.medium,
    textDecoration: "none",
  },
});
