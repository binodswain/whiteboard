import { fontSize, radius } from "@canvas/scale.stylex";
import type { ReviewFilter } from "@review/review-api/review-filter";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { tokens } from "./tokens.stylex";

/* Per-browser until sign-in names a user: there is no server-side notion of
   the viewer's branch yet. */
const MY_BRANCH_KEY = "whiteboard.review.myBranch";

function readMyBranch(): string {
  try {
    return localStorage.getItem(MY_BRANCH_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeMyBranch(value: string) {
  try {
    localStorage.setItem(MY_BRANCH_KEY, value);
  } catch {
    // Storage is unavailable in some private windows; the value lasts this page.
  }
}

export function ReviewFilterBar({
  filter,
  repositoryNames,
  onChange,
}: {
  filter: ReviewFilter;
  repositoryNames: readonly string[];
  onChange(filter: ReviewFilter): void;
}) {
  const [myBranch, setMyBranch] = useState(readMyBranch);
  const active = Object.values(filter).some(Boolean);

  const set = (key: keyof ReviewFilter, value: string) =>
    onChange({ ...filter, [key]: value.trim() || undefined });

  const toggleBranch = (branch: string) =>
    onChange({
      ...filter,
      branch: filter.branch === branch ? undefined : branch,
    });

  return (
    <form
      role="search"
      aria-label="Filter sessions"
      {...stylex.props(styles.bar)}
      onSubmit={(event) => event.preventDefault()}
    >
      <button
        type="button"
        {...stylex.props(styles.chip)}
        aria-pressed={filter.branch === "main"}
        onClick={() => toggleBranch("main")}
      >
        Latest on main
      </button>
      <button
        type="button"
        {...stylex.props(styles.chip)}
        aria-pressed={Boolean(myBranch) && filter.branch === myBranch}
        disabled={!myBranch}
        title={myBranch ? undefined : "Set your branch below first"}
        onClick={() => toggleBranch(myBranch)}
      >
        Latest on my branch
      </button>
      <select
        {...stylex.props(styles.field)}
        aria-label="Repository"
        value={filter.repo ?? ""}
        onChange={(event) => set("repo", event.target.value)}
      >
        <option value="">All repos</option>
        {repositoryNames.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <input
        {...stylex.props(styles.field)}
        aria-label="Branch"
        placeholder="Branch"
        value={filter.branch ?? ""}
        onChange={(event) => set("branch", event.target.value)}
      />
      <input
        {...stylex.props(styles.field)}
        aria-label="Commit"
        placeholder="Commit"
        value={filter.commit ?? ""}
        onChange={(event) => set("commit", event.target.value.toLowerCase())}
      />
      <input
        {...stylex.props(styles.field)}
        aria-label="Author"
        placeholder="Author"
        value={filter.author ?? ""}
        onChange={(event) => set("author", event.target.value)}
      />
      <input
        {...stylex.props(styles.field)}
        aria-label="Tag"
        placeholder="Tag"
        value={filter.tag ?? ""}
        onChange={(event) => set("tag", event.target.value.toLowerCase())}
      />
      <input
        {...stylex.props(styles.field)}
        aria-label="Your branch"
        placeholder="Your branch"
        value={myBranch}
        onChange={(event) => {
          setMyBranch(event.target.value.trim());
          writeMyBranch(event.target.value.trim());
        }}
      />
      {active ? (
        <button
          type="button"
          {...stylex.props(styles.chip)}
          onClick={() => onChange({})}
        >
          Clear filters
        </button>
      ) : null}
    </form>
  );
}

const styles = stylex.create({
  bar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "8px",
    marginBlock: "12px",
  },
  chip: {
    minHeight: "28px",
    padding: "0 10px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.rule,
    borderRadius: radius.control,
    backgroundColor: tokens.tray,
    color: tokens.ink,
    font: "inherit",
    fontSize: fontSize.ui,
    cursor: "pointer",
    ":disabled": { color: tokens.inkMuted, cursor: "default" },
    ":is([aria-pressed=true])": { borderColor: tokens.ink },
  },
  field: {
    boxSizing: "border-box",
    width: "128px",
    minHeight: "28px",
    padding: "0 8px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.rule,
    borderRadius: radius.control,
    backgroundColor: tokens.tray,
    color: tokens.ink,
    font: "inherit",
    fontSize: fontSize.ui,
  },
});
