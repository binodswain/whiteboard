import { Button } from "@canvas/ui/button";
import { TextField, fieldStyles } from "@canvas/ui/text-field";
import type {
  ReviewAdminSettings,
  ReviewAdminSettingsPatch,
  ReviewAdminSettingsView,
} from "@dev.fast/review-protocol";
import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useEffect, useState } from "react";

import { settingsStyles as styles } from "./settings-styles";

const adminStyles = stylex.create({
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    marginTop: "8px",
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  check: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
});

interface Draft {
  repos: string;
  drafts: boolean;
  authoring: boolean;
  provider: string;
  model: string;
  /** Empty keeps the stored key. */
  apiKey: string;
}

const draftOf = (view: ReviewAdminSettingsView): Draft => ({
  repos: view.prReviews.repos.join("\n"),
  drafts: view.prReviews.drafts,
  authoring: view.prReviews.authoring,
  provider: view.reviewer.provider ?? "",
  model: view.reviewer.model ?? "",
  apiKey: "",
});

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Pull request review settings a deployment admin edits in place of server
 * environment variables. The reviewer's API key is write-only: the page shows
 * whether one is stored, never the key.
 */
export function AdminSettingsSection({
  actions,
  frame,
}: {
  actions: ReviewAdminSettings;
  frame: (body: ReactNode) => ReactNode;
}) {
  const [view, setView] = useState<ReviewAdminSettingsView | null>();
  const [draft, setDraft] = useState<Draft | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    actions
      .read()
      .then((loaded) => {
        setView(loaded);

        if (loaded) setDraft(draftOf(loaded));
      })
      .catch((cause) => setError(message(cause)));
  }, [actions]);

  // Only admins see the section at all.
  if (view === null || (view === undefined && !error)) return null;

  const save = async (patch: ReviewAdminSettingsPatch) => {
    setBusy(true);
    setError(null);
    setSaved(false);

    try {
      const next = await actions.update(patch);
      setView(next);
      setDraft(draftOf(next));
      setSaved(true);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (!draft) return;

    void save({
      prReviews: {
        repos: draft.repos
          .split(/[\s,]+/)
          .map((repo) => repo.trim())
          .filter(Boolean),
        drafts: draft.drafts,
        authoring: draft.authoring,
      },
      reviewer: {
        provider: draft.provider || null,
        model: draft.model.trim() || null,
        ...(draft.apiKey.trim() && { apiKey: draft.apiKey.trim() }),
      },
    });
  };

  const edit = (change: Partial<Draft>) => {
    setSaved(false);
    setDraft((current) => current && { ...current, ...change });
  };

  return frame(
    <div>
      <p {...stylex.props(styles.rowDescription)}>
        Which repositories get a whiteboard for each pull request, and the model
        that writes its summary. Saved settings apply on the next pull request;
        no restart needed.
      </p>

      {view && draft ? (
        <form
          {...stylex.props(adminStyles.form)}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label {...stylex.props(adminStyles.field)}>
            <span {...stylex.props(styles.rowLabel)}>Repositories</span>
            <textarea
              {...stylex.props(fieldStyles.box, fieldStyles.multiline)}
              aria-label="Repositories"
              placeholder="owner/repo, one per line"
              rows={4}
              value={draft.repos}
              onChange={(event) => edit({ repos: event.target.value })}
            />
          </label>

          <label {...stylex.props(adminStyles.check)}>
            <input
              type="checkbox"
              {...stylex.props(styles.checkbox)}
              checked={draft.drafts}
              onChange={(event) => edit({ drafts: event.target.checked })}
            />
            <span {...stylex.props(styles.rowLabel)}>
              Review draft pull requests
            </span>
          </label>

          <label {...stylex.props(adminStyles.check)}>
            <input
              type="checkbox"
              {...stylex.props(styles.checkbox)}
              checked={draft.authoring}
              onChange={(event) => edit({ authoring: event.target.checked })}
            />
            <span {...stylex.props(styles.rowLabel)}>
              Have the reviewer write a summary
            </span>
          </label>

          <label {...stylex.props(adminStyles.field)}>
            <span {...stylex.props(styles.rowLabel)}>Provider</span>
            <select
              {...stylex.props(fieldStyles.box)}
              aria-label="Provider"
              value={draft.provider}
              onChange={(event) => edit({ provider: event.target.value })}
            >
              <option value="">Runner default</option>
              {view.providers.map((provider) => (
                <option key={provider} value={provider}>
                  {provider}
                </option>
              ))}
            </select>
          </label>

          <div {...stylex.props(adminStyles.field)}>
            <label htmlFor="admin-model" {...stylex.props(styles.rowLabel)}>
              Model
            </label>
            <TextField
              id="admin-model"
              xstyle={styles.input}
              placeholder="Provider default"
              value={draft.model}
              onChange={(event) => edit({ model: event.target.value })}
            />
          </div>

          <div {...stylex.props(adminStyles.field)}>
            <label htmlFor="admin-api-key" {...stylex.props(styles.rowLabel)}>
              API key{" "}
              <span {...stylex.props(styles.rowDescription)}>
                {view.reviewer.apiKeySet
                  ? "Stored, encrypted — leave blank to keep it"
                  : "Not set"}
              </span>
            </label>
            <TextField
              id="admin-api-key"
              xstyle={styles.input}
              type="password"
              autoComplete="off"
              placeholder={view.reviewer.apiKeySet ? "••••••••" : "Paste a key"}
              value={draft.apiKey}
              onChange={(event) => edit({ apiKey: event.target.value })}
            />
          </div>

          <div {...stylex.props(adminStyles.actions)}>
            <Button type="submit" disabled={busy}>
              Save
            </Button>
            {view.reviewer.apiKeySet ? (
              <Button
                variant="warning"
                disabled={busy}
                onClick={() => void save({ reviewer: { apiKey: null } })}
              >
                Remove key
              </Button>
            ) : null}
            <span {...stylex.props(styles.rowDescription)} role="status">
              {saved
                ? "Saved."
                : view.updatedAt
                  ? `Last saved ${view.updatedAt.slice(0, 10)}${view.updatedBy ? ` by ${view.updatedBy}` : ""}`
                  : null}
            </span>
          </div>
        </form>
      ) : null}

      {error ? <p {...stylex.props(styles.error)}>{error}</p> : null}
    </div>,
  );
}
