import { layer, radius } from "@canvas/scale.stylex";
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
import { tokens } from "./tokens.stylex";

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
  picker: {
    position: "relative",
  },
  options: {
    position: "absolute",
    zIndex: layer.popover,
    insetInline: 0,
    top: "calc(100% + 4px)",
    maxHeight: "240px",
    overflowY: "auto",
    margin: 0,
    padding: "4px 0",
    listStyle: "none",
    backgroundColor: tokens.raised,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.reviewHomeRuleSoft,
    borderRadius: radius.control,
  },
  option: {
    padding: "4px 10px",
    cursor: "pointer",
    backgroundColor: {
      default: "transparent",
      ":hover": tokens.reviewHomeRuleSoft,
    },
  },
  optionActive: {
    backgroundColor: tokens.reviewHomeRuleSoft,
  },
  chips: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "2px 4px 2px 8px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.reviewHomeRuleSoft,
    borderRadius: radius.control,
  },
  remove: {
    border: "none",
    background: "none",
    color: "inherit",
    cursor: "pointer",
    padding: "0 4px",
    fontSize: "1.1em",
    lineHeight: 1,
  },
});

const REPO = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

/**
 * Pick repositories from the admin's GitHub list, searchable; an `owner/repo`
 * GitHub did not list (or a list that failed) can still be typed and added.
 */
function RepoPicker({
  actions,
  value,
  onChange,
}: {
  actions: ReviewAdminSettings;
  value: string[];
  onChange: (repos: string[]) => void;
}) {
  const [available, setAvailable] = useState<
    { name: string; private: boolean }[] | undefined
  >();

  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    actions
      .repositories()
      .then(setAvailable)
      .catch((cause) => {
        setAvailable([]);
        setLoadError(message(cause));
      });
  }, [actions]);

  const needle = query.trim().toLowerCase();

  const matches = (available ?? [])
    .filter((repo) => !value.includes(repo.name) && repo.name.includes(needle))
    .slice(0, 50);

  const typed =
    REPO.test(needle) &&
    !value.includes(needle) &&
    !matches.some((repo) => repo.name === needle)
      ? needle
      : undefined;

  const choices = [...(typed ? [typed] : []), ...matches.map((r) => r.name)];

  const add = (repo: string) => {
    onChange([...value, repo].sort());
    setQuery("");
    setActive(0);
  };

  return (
    <div {...stylex.props(adminStyles.field)}>
      <span {...stylex.props(styles.rowLabel)} id="admin-repos-label">
        Repositories
      </span>
      <div {...stylex.props(adminStyles.picker)}>
        <TextField
          xstyle={styles.input}
          role="combobox"
          tabIndex={0}
          aria-labelledby="admin-repos-label"
          aria-expanded={open && choices.length > 0}
          aria-controls="admin-repos-options"
          placeholder={
            available === undefined
              ? "Loading your repositories…"
              : "Search repositories, or type owner/repo"
          }
          value={query}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, choices.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              // Never submit the form from the search box.
              event.preventDefault();

              const choice = choices[active];

              if (choice) add(choice);
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
        />
        {open && choices.length > 0 ? (
          <ul
            id="admin-repos-options"
            role="listbox"
            {...stylex.props(adminStyles.options)}
          >
            {choices.map((repo, index) => (
              <li
                key={repo}
                role="option"
                aria-selected={index === active}
                {...stylex.props(
                  adminStyles.option,
                  index === active && adminStyles.optionActive,
                )}
                // Before the input's blur closes the list.
                onMouseDown={(event) => {
                  event.preventDefault();
                  add(repo);
                }}
              >
                {repo === typed ? `Add “${repo}”` : repo}
                {available?.find((r) => r.name === repo)?.private
                  ? " · private"
                  : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {loadError ? (
        <span {...stylex.props(styles.rowDescription)}>
          {loadError} Type owner/repo to add one.
        </span>
      ) : null}
      {value.length === 0 ? (
        <span {...stylex.props(styles.rowDescription)}>
          No repositories yet; pull requests get no whiteboard.
        </span>
      ) : (
        <ul
          {...stylex.props(adminStyles.chips)}
          aria-label="Selected repositories"
        >
          {value.map((repo) => (
            <li key={repo} {...stylex.props(adminStyles.chip)}>
              {repo}
              <button
                type="button"
                {...stylex.props(adminStyles.remove)}
                aria-label={`Remove ${repo}`}
                onClick={() => onChange(value.filter((r) => r !== repo))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface Draft {
  repos: string[];
  drafts: boolean;
  authoring: boolean;
  provider: string;
  model: string;
  /** Empty keeps the stored key. */
  apiKey: string;
}

const draftOf = (view: ReviewAdminSettingsView): Draft => ({
  repos: view.prReviews.repos,
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

  const [keyCheck, setKeyCheck] = useState<
    { ok: boolean; message: string } | undefined
  >();

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

  /** Asks the provider whether the key (typed, else stored) works. */
  const check = async (current: Draft) => {
    setKeyCheck(undefined);

    const result = await actions.checkKey({
      provider: current.provider,
      ...(current.model.trim() && { model: current.model.trim() }),
      ...(current.apiKey.trim() && { apiKey: current.apiKey.trim() }),
    });

    setKeyCheck(result);

    return result;
  };

  const testKey = async () => {
    if (!draft?.provider) return;

    setBusy(true);
    setError(null);

    try {
      await check(draft);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!draft) return;

    // A new key is tried before it is stored, so a bad one fails here rather
    // than on the next pull request.
    if (draft.apiKey.trim() && draft.provider) {
      setBusy(true);
      setError(null);

      try {
        if (!(await check(draft)).ok) return;
      } catch (cause) {
        setError(message(cause));

        return;
      } finally {
        setBusy(false);
      }
    }

    void save({
      prReviews: {
        repos: draft.repos,
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

    if ("provider" in change || "model" in change || "apiKey" in change)
      setKeyCheck(undefined);

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
            void submit();
          }}
        >
          <RepoPicker
            actions={actions}
            value={draft.repos}
            onChange={(repos) => edit({ repos })}
          />

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
            {keyCheck ? (
              <span
                {...stylex.props(
                  keyCheck.ok ? styles.rowDescription : styles.error,
                )}
                role="status"
              >
                {keyCheck.message}
              </span>
            ) : null}
          </div>

          <div {...stylex.props(adminStyles.actions)}>
            <Button type="submit" disabled={busy}>
              Save
            </Button>
            <Button
              disabled={
                busy ||
                !draft.provider ||
                (!draft.apiKey.trim() && !view.reviewer.apiKeySet)
              }
              onClick={() => void testKey()}
            >
              Test key
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
