import { type DiffSelection, formatAnchor } from "@review/lens-selection";
import * as stylex from "@stylexjs/stylex";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ReactNode,
  createContext,
  useContext,
  useMemo,
  useState,
} from "react";

import { canvasQueryKeys } from "./canvas-query";
import { type ReviewSession, useReviewSession } from "./host/review-session";
import { fontSize, layer, radius } from "./scale.stylex";
import { tokens } from "./tokens.stylex";
import { Button } from "./ui/button";
import { surfaceStyles } from "./ui/surface";

export interface ReviewComment {
  id: string;
  anchor?: string;
  parentId?: string;
  body: string;
  author: string;
  resolved: boolean;
  outdated: boolean;
  createdAt: string;
}

interface CommentDraft {
  body: string;
  anchor?: string;
  parentId?: string;
}

export interface ReviewCommentsValue {
  open: boolean;
  anchor?: string;
  comments: ReviewComment[];
  show(anchor?: string): void;
  toggle(): void;
  hide(): void;
  add(draft: CommentDraft): Promise<void>;
  setResolved(commentId: string, resolved: boolean): Promise<void>;
}

const ReviewCommentsContext = createContext<ReviewCommentsValue | null>(null);

export function useOptionalReviewComments(): ReviewCommentsValue | null {
  return useContext(ReviewCommentsContext);
}

/** The anchor a code selection's lines are commented on. */
export function codeSelectionAnchor(selection: {
  path: string;
  side: "base" | "head";
  startLine: number;
  endLine: number;
}): string {
  const source: DiffSelection = {
    file: selection.path,
    start: { side: selection.side, line: selection.startLine },
    end: { side: selection.side, line: selection.endLine },
  };

  return formatAnchor(source);
}

async function requestJson<T>(
  session: ReviewSession,
  endpoint: `/${string}`,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<T> {
  const response = await session.fetch(endpoint, {
    method: init.method,
    headers:
      init.body === undefined
        ? undefined
        : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  // SAFETY: the server answers with the T this endpoint is documented to return, or an { error } body.
  const payload = (await response.json()) as T & { error?: string };

  if (!response.ok)
    throw new Error(payload.error ?? "The comment could not be saved.");

  return payload;
}

export function ReviewCommentsProvider({
  version,
  children,
}: {
  version: number;
  children: ReactNode;
}) {
  const session = useReviewSession();
  const queryClient = useQueryClient();

  const [panel, setPanel] = useState<{ open: boolean; anchor?: string }>({
    open: false,
  });

  const queryKey = canvasQueryKeys.comments(version);

  const list = useQuery({
    queryKey,
    queryFn: () =>
      requestJson<{ comments: ReviewComment[] }>(session, "/comments", {
        method: "GET",
      }),
  });

  const write = useMutation({
    mutationFn: (draft: CommentDraft) =>
      requestJson<ReviewComment>(session, "/comments", {
        method: "POST",
        body: draft,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const resolve = useMutation({
    mutationFn: (input: { commentId: string; resolved: boolean }) =>
      requestJson<{ comments: ReviewComment[] }>(session, "/comments/resolve", {
        method: "POST",
        body: { commentId: input.commentId, resolved: input.resolved },
      }),
    onSuccess: (next) => queryClient.setQueryData(queryKey, next),
  });

  const { mutateAsync: writeComment } = write;
  const { mutateAsync: resolveComment } = resolve;
  const comments = list.data?.comments;

  const value = useMemo<ReviewCommentsValue>(
    () => ({
      open: panel.open,
      anchor: panel.anchor,
      comments: comments ?? [],
      show: (anchor) => setPanel({ open: true, anchor }),
      toggle: () => setPanel((current) => ({ open: !current.open })),
      hide: () => setPanel({ open: false }),
      add: async (draft) => {
        await writeComment(draft);
      },
      setResolved: async (commentId, resolved) => {
        await resolveComment({ commentId, resolved });
      },
    }),
    [panel, comments, writeComment, resolveComment],
  );

  return (
    <ReviewCommentsContext.Provider value={value}>
      {children}
      {panel.open && <CommentsPanel value={value} />}
    </ReviewCommentsContext.Provider>
  );
}

export function CommentsControl() {
  const comments = useOptionalReviewComments();

  if (!comments) return null;

  const open = comments.comments.filter(
    (comment) => !comment.parentId && !comment.resolved,
  ).length;

  return (
    <Button
      variant="ghost"
      aria-expanded={comments.open}
      onClick={comments.toggle}
    >
      Comments{open > 0 ? ` (${open})` : ""}
    </Button>
  );
}

function CommentsPanel({ value }: { value: ReviewCommentsValue }) {
  const roots = value.comments.filter((comment) => !comment.parentId);

  return (
    <aside {...stylex.props(surfaceStyles.popover, styles.panel)}>
      <header {...stylex.props(styles.header)}>
        <strong>Comments</strong>
        <Button variant="ghost" onClick={value.hide}>
          Close
        </Button>
      </header>
      <Composer
        placeholder="Add a comment"
        anchor={value.anchor}
        submitLabel="Comment"
        onSubmit={(body) =>
          value.add({ body, anchor: value.anchor, parentId: undefined })
        }
      />
      {roots.length === 0 && (
        <p {...stylex.props(styles.muted)}>No comments yet.</p>
      )}
      {roots.map((root) => (
        <Thread
          key={root.id}
          root={root}
          replies={value.comments.filter(
            (comment) => comment.parentId === root.id,
          )}
          onReply={(body) => value.add({ body, parentId: root.id })}
          onResolve={(resolved) => value.setResolved(root.id, resolved)}
        />
      ))}
    </aside>
  );
}

function Thread({
  root,
  replies,
  onReply,
  onResolve,
}: {
  root: ReviewComment;
  replies: ReviewComment[];
  onReply(body: string): Promise<void>;
  onResolve(resolved: boolean): Promise<void>;
}) {
  const [replying, setReplying] = useState(false);

  return (
    <section {...stylex.props(styles.thread)}>
      <div {...stylex.props(styles.meta)}>
        <code>{root.anchor ?? "Whole review"}</code>
        {root.outdated && <span {...stylex.props(styles.badge)}>Outdated</span>}
        {root.resolved && <span {...stylex.props(styles.badge)}>Resolved</span>}
      </div>
      <Message comment={root} />
      {replies.map((reply) => (
        <div key={reply.id} {...stylex.props(styles.reply)}>
          <Message comment={reply} />
        </div>
      ))}
      <div {...stylex.props(styles.actions)}>
        <Button variant="ghost" onClick={() => setReplying((on) => !on)}>
          Reply
        </Button>
        <Button variant="ghost" onClick={() => void onResolve(!root.resolved)}>
          {root.resolved ? "Reopen" : "Resolve"}
        </Button>
      </div>
      {replying && (
        <Composer
          placeholder="Reply"
          submitLabel="Reply"
          onSubmit={async (body) => {
            await onReply(body);
            setReplying(false);
          }}
        />
      )}
    </section>
  );
}

function Message({ comment }: { comment: ReviewComment }) {
  return (
    <p {...stylex.props(styles.message)}>
      <span {...stylex.props(styles.muted)}>
        {comment.author} · {new Date(comment.createdAt).toLocaleString()}
      </span>
      <br />
      {comment.body}
    </p>
  );
}

function Composer({
  placeholder,
  anchor,
  submitLabel,
  onSubmit,
}: {
  placeholder: string;
  anchor?: string;
  submitLabel: string;
  onSubmit(body: string): Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = async () => {
    const text = body.trim();

    if (!text || saving) return;
    setSaving(true);
    setError(undefined);

    try {
      await onSubmit(text);
      setBody("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      {...stylex.props(styles.composer)}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {anchor && <code {...stylex.props(styles.muted)}>On {anchor}</code>}
      <textarea
        {...stylex.props(styles.textarea)}
        aria-label={placeholder}
        placeholder={placeholder}
        rows={3}
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      {error && (
        <p role="alert" {...stylex.props(styles.muted)}>
          {error}
        </p>
      )}
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={!body.trim() || saving}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

const styles = stylex.create({
  panel: {
    position: "fixed",
    top: "64px",
    right: "16px",
    bottom: "16px",
    width: "340px",
    overflowY: "auto",
    zIndex: layer.agentSelection,
    padding: "12px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  thread: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: tokens.chromeBorder,
    paddingTop: "10px",
  },
  meta: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    flexWrap: "wrap",
    fontSize: fontSize.micro,
  },
  badge: {
    padding: "0 6px",
    borderRadius: radius.pill,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.chromeBorder,
    fontSize: fontSize.micro,
  },
  message: {
    margin: 0,
    whiteSpace: "pre-wrap",
  },
  reply: {
    marginLeft: "12px",
  },
  actions: {
    display: "flex",
    gap: "4px",
  },
  composer: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  },
  textarea: {
    font: "inherit",
    resize: "vertical",
    padding: "6px",
    borderRadius: radius.control,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.chromeBorder,
    backgroundColor: "transparent",
    color: "inherit",
  },
  muted: {
    opacity: 0.7,
    fontSize: fontSize.micro,
    margin: 0,
  },
});
