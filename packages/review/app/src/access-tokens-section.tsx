import { radius } from "@canvas/scale.stylex";
import { Button } from "@canvas/ui/button";
import { TextField } from "@canvas/ui/text-field";
import type {
  ReviewAccessToken,
  ReviewAccessTokens,
} from "@dev.fast/review-protocol";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

import { settingsStyles as styles } from "./settings-styles";
import { tokens } from "./tokens.stylex";

const tokenStyles = stylex.create({
  list: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    marginTop: "8px",
    listStyle: "none",
    padding: 0,
  },
  item: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
  },
  meta: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  },
  form: {
    display: "flex",
    gap: "8px",
    marginTop: "12px",
  },
  created: {
    marginTop: "8px",
    padding: "8px 10px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.reviewHomeRuleSoft,
    borderRadius: radius.control,
    overflowWrap: "anywhere",
    fontFamily: "monospace",
    fontSize: "0.9em",
    userSelect: "text",
    whiteSpace: "pre-wrap",
  },
});

/**
 * Personal API tokens for CLI and MCP access on a hosted deployment. A token
 * is shown once, when it is created; afterwards the row is name and dates.
 */
export function AccessTokensSection({
  tokens: actions,
}: {
  tokens: ReviewAccessTokens;
}) {
  const [items, setItems] = useState<ReviewAccessToken[] | undefined>();
  const [name, setName] = useState("");

  const [created, setCreated] = useState<
    (ReviewAccessToken & { token: string }) | undefined
  >();

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    actions
      .list()
      .then(setItems)
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, [actions]);

  const create = async () => {
    setBusy("create");
    setError(null);

    try {
      const record = await actions.create(name.trim());
      setCreated(record);
      setItems((current) => [...(current ?? []), record]);
      setName("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (id: string) => {
    setBusy(id);
    setError(null);

    try {
      await actions.revoke(id);
      setItems((current) => current?.filter((item) => item.id !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <p {...stylex.props(styles.rowDescription)}>
        Personal API tokens authenticate the whiteboard CLI and MCP clients,
        sent as Authorization: Bearer. A token is readable only when created.
      </p>

      {items === undefined ? null : items.length === 0 ? (
        <p {...stylex.props(styles.unavailable)}>No tokens yet.</p>
      ) : (
        <ul {...stylex.props(tokenStyles.list)}>
          {items.map((item) => (
            <li key={item.id} {...stylex.props(tokenStyles.item)}>
              <span {...stylex.props(tokenStyles.meta)}>
                <span {...stylex.props(styles.rowLabel)}>{item.name}</span>
                <span {...stylex.props(styles.rowDescription)}>
                  Created {item.createdAt.slice(0, 10)}
                  {item.lastUsedAt
                    ? ` · Last used ${item.lastUsedAt.slice(0, 10)}`
                    : " · Never used"}
                </span>
              </span>
              <Button
                variant="warning"
                disabled={busy !== null}
                onClick={() => void revoke(item.id)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      {created ? (
        <div {...stylex.props(tokenStyles.created)} role="status">
          {`New token “${created.name}” — copy it now; it is not shown again.`}
          {"\n"}
          {created.token}
        </div>
      ) : null}

      <form
        {...stylex.props(tokenStyles.form)}
        onSubmit={(event) => {
          event.preventDefault();

          if (name.trim()) void create();
        }}
      >
        <TextField
          xstyle={styles.input}
          aria-label="Token name"
          placeholder="Token name (e.g. my laptop)"
          value={name}
          required
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" disabled={busy !== null || !name.trim()}>
          Create token
        </Button>
      </form>

      {error ? <p {...stylex.props(styles.error)}>{error}</p> : null}
    </div>
  );
}
