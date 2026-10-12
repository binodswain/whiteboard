import { fontSize, fontWeight } from "@canvas/scale.stylex";
import { Button } from "@canvas/ui/button";
import { textStyles } from "@canvas/ui/text";
import type {
  AskAgentStatusLike,
  ReviewApiRepository,
  ReviewApiSummary,
  ReviewSessionCreateInput,
} from "@dev.fast/review-protocol";
import * as stylex from "@stylexjs/stylex";
import { type ReactElement, useEffect, useState } from "react";

import { tokens } from "./tokens.stylex";
import { ProgressBar } from "./ui/progress-bar";

/** How long a just-started index may sit before an agent shows as working. */
export const PROJECT_INDEX_START_GRACE_MS = 20_000;

export function projectIndexTitle(repository: ReviewApiRepository): string {
  return `Project index: ${repository.name}`;
}

export function projectIndexPrompt(repository: ReviewApiRepository): string {
  return [
    `Index the project "${repository.name}" so a newcomer can find their way around it.`,
    "Read the repository, then author in this session: a short overview of what the project does and how it is laid out, a software map of its main systems, containers and components, and one diagram of the most important flow.",
    "Anchor claims to the source. Do not modify repository files.",
  ].join(" ");
}

export type ProjectIndexState =
  | { status: "none" }
  | { status: "starting" }
  | { status: "running"; review: ReviewApiSummary }
  | { status: "ready"; review: ReviewApiSummary };

/**
 * Where a repository's index stands. The index is an ordinary session with a
 * reserved title, so its state is read off the catalog: an agent holding a
 * lease means it is running, and the session alone means the last run ended.
 * `started` covers the gap before the catalog first shows the new session.
 */
export function projectIndexState(
  repository: ReviewApiRepository,
  reviews: readonly ReviewApiSummary[],
  started: { at: number; knownIds: ReadonlySet<string> } | undefined,
  now: number,
): ProjectIndexState {
  const title = projectIndexTitle(repository);

  const review = reviews
    .filter(
      (candidate) =>
        candidate.title === title &&
        !candidate.dismissedAt &&
        (candidate.pins?.repositoryId ?? candidate.target?.repositoryId) ===
          repository.id,
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

  if (review?.working) return { status: "running", review };

  // The session this run creates is not in the catalog the click saw, so a
  // match from that catalog is an older run. Comparing ids avoids trusting the
  // server's clock against the browser's.
  if (
    started !== undefined &&
    now - started.at < PROJECT_INDEX_START_GRACE_MS &&
    (!review || started.knownIds.has(review.reviewId))
  )
    return { status: "starting" };

  return review ? { status: "ready", review } : { status: "none" };
}

export function ProjectIndexSection({
  repositories,
  reviews,
  askAgents,
  createSession,
  onOpen,
  formatTime,
}: {
  repositories: readonly ReviewApiRepository[];
  reviews: readonly ReviewApiSummary[];
  askAgents?(): Promise<readonly AskAgentStatusLike[]>;
  createSession(input: ReviewSessionCreateInput): Promise<ReviewApiSummary>;
  onOpen(review: ReviewApiSummary): void;
  formatTime(timestamp: string | null | undefined): string;
}): ReactElement {
  const [started, setStarted] = useState<
    ReadonlyMap<string, { at: number; knownIds: ReadonlySet<string> }>
  >(new Map());

  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [now, setNow] = useState(() => Date.now());

  // Re-evaluate once the start grace runs out; otherwise the state is driven
  // by catalog updates.
  useEffect(() => {
    if (started.size === 0) return;

    const timer = setTimeout(
      () => setNow(Date.now()),
      PROJECT_INDEX_START_GRACE_MS + 50,
    );

    return () => clearTimeout(timer);
  }, [started]);

  const setError = (id: string, message: string | undefined) =>
    setErrors((current) => {
      const next = new Map(current);

      if (message === undefined) next.delete(id);
      else next.set(id, message);

      return next;
    });

  const start = async (repository: ReviewApiRepository) => {
    setError(repository.id, undefined);

    try {
      const agents = (await askAgents?.()) ?? [];
      const agent = agents.find((candidate) => candidate.available);

      if (!agent) {
        setError(
          repository.id,
          "No agent CLI is ready. Connect one in setup, then try again.",
        );

        return;
      }

      const began = Date.now();

      setStarted((current) =>
        new Map(current).set(repository.id, {
          at: began,
          knownIds: new Set(reviews.map((review) => review.reviewId)),
        }),
      );
      setNow(began);
      await createSession({
        title: projectIndexTitle(repository),
        repositoryId: repository.id,
        task: { prompt: projectIndexPrompt(repository), agent: agent.id },
      });
    } catch (error) {
      setStarted((current) => {
        const next = new Map(current);

        next.delete(repository.id);

        return next;
      });
      setError(
        repository.id,
        error instanceof Error
          ? error.message
          : "Could not start indexing. Please try again.",
      );
    }
  };

  return (
    <section
      {...stylex.props(styles.section)}
      aria-labelledby="project-index-heading"
    >
      <h2
        id="project-index-heading"
        {...stylex.props(textStyles.eyebrow, styles.heading)}
      >
        Project index
      </h2>
      <ul {...stylex.props(styles.list)}>
        {repositories.map((repository) => {
          const state = projectIndexState(
            repository,
            reviews,
            started.get(repository.id),
            now,
          );

          const error = errors.get(repository.id);

          const busy =
            state.status === "starting" || state.status === "running";

          return (
            <li key={repository.id} {...stylex.props(styles.row)}>
              <div {...stylex.props(styles.info)}>
                <span {...stylex.props(styles.name)}>{repository.name}</span>
                <span {...stylex.props(styles.status)} role="status">
                  {error ??
                    (state.status === "none"
                      ? "Not indexed yet"
                      : state.status === "starting"
                        ? "Starting the agent…"
                        : state.status === "running"
                          ? "Indexing: the agent is reading the project"
                          : `Last indexed ${formatTime(state.review.createdAt)}`)}
                </span>
                {busy ? (
                  <ProgressBar label={`Indexing ${repository.name}`} />
                ) : null}
              </div>
              <div {...stylex.props(styles.actions)}>
                {state.status === "running" || state.status === "ready" ? (
                  <Button onClick={() => onOpen(state.review)}>
                    {state.status === "running" ? "Watch" : "Open"}
                  </Button>
                ) : null}
                <Button
                  variant={state.status === "none" ? "primary" : "secondary"}
                  disabled={busy}
                  onClick={() => void start(repository)}
                >
                  {state.status === "ready"
                    ? "Re-index"
                    : error
                      ? "Try again"
                      : "Index project"}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const styles = stylex.create({
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  heading: {
    margin: 0,
  },
  name: {
    fontWeight: fontWeight.semibold,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: tokens.rule,
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
    paddingBlock: "10px",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: tokens.rule,
  },
  info: {
    display: "flex",
    flexDirection: "column",
    flex: "1 1 auto",
    gap: "4px",
    minWidth: 0,
  },
  status: {
    color: tokens.inkFaint,
    fontSize: fontSize.small,
  },
  actions: {
    display: "flex",
    flex: "none",
    gap: "8px",
  },
});
