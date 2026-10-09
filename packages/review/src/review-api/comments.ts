import { randomUUID } from "node:crypto";

import {
  anchorSchema,
  formatAnchor,
  parseAnchor,
} from "@review/lens-selection.js";
import { z } from "zod";

import { ReviewInputError } from "./input-error.js";
import type { MetadataStore } from "./storage/metadata-store.js";

/** Where a thread points: a source range ("head/path#L10-L12"), a diagram
 * element ("element:<id>"), or nothing for the whole review. */
export const commentAnchorSchema = anchorSchema
  .refine((text) => {
    const selection = parseAnchor(text);

    return selection?.start.side === selection?.end.side;
  }, "Comments anchor to one side of a file: use head/path#L10-L12 or base/path#L7.")
  .or(z.string().regex(/^element:.+$/, "Expected element:<id>."));

export const commentInputSchema = z.strictObject({
  body: z.string().trim().min(1).max(20_000),
  author: z.string().trim().min(1).max(200).optional(),
  anchor: commentAnchorSchema.nullish(),
  parentId: z.string().min(1).optional(),
});

export type CommentInput = z.infer<typeof commentInputSchema>;

export interface ReviewComment {
  id: string;
  reviewId: string;
  /** The version the anchor was last checked against. */
  version: number;
  anchor?: string;
  /** The thread root a reply belongs to; absent on a root. */
  parentId?: string;
  body: string;
  author: string;
  resolved: boolean;
  /** The anchored lines changed in a later version and no longer match. */
  outdated: boolean;
  createdAt: string;
  updatedAt: string;
}

interface CommentRow {
  id: string;
  review_id: string;
  version: number;
  anchor: string | null;
  parent_id: string | null;
  body: string;
  author: string;
  resolved: number;
  outdated: number;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  "id,review_id,version,anchor,parent_id,body,author,resolved,outdated,created_at,updated_at";

const toComment = (row: CommentRow): ReviewComment => ({
  id: row.id,
  reviewId: row.review_id,
  version: Number(row.version),
  ...(row.anchor !== null && { anchor: row.anchor }),
  ...(row.parent_id !== null && { parentId: row.parent_id }),
  body: row.body,
  author: row.author,
  resolved: Number(row.resolved) === 1,
  outdated: Number(row.outdated) === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Lines of one file at one side of the review, or undefined when the file
 * can't be read there. */
export type LineReader = (
  side: "base" | "head",
  file: string,
) => Promise<string | undefined>;

/** The line range `[start, end]` (1-based, inclusive) found again in `next`,
 * or undefined when it is gone or ambiguous. The original position wins so
 * an unchanged range never moves. */
export function relocateLines(
  previous: string[],
  next: string[],
  start: number,
  end: number,
): { start: number; end: number } | undefined {
  const block = previous.slice(start - 1, end);

  if (block.length === 0 || previous.length < end) return undefined;

  const matches: number[] = [];

  for (let at = 0; at + block.length <= next.length; at++)
    if (block.every((line, offset) => next[at + offset] === line))
      matches.push(at + 1);

  if (matches.includes(start)) return { start, end: start + block.length - 1 };

  if (matches.length !== 1) return undefined;

  return { start: matches[0]!, end: matches[0]! + block.length - 1 };
}

interface MovedThread {
  anchor: string;
  outdated: boolean;
}

/** Threads on one review. Stored comments are roots (anchor, if any) and
 * replies (parentId names the root). */
export class ReviewComments {
  constructor(private readonly meta: MetadataStore) {}

  async add(
    reviewId: string,
    version: number,
    input: CommentInput,
  ): Promise<ReviewComment> {
    const now = new Date().toISOString();
    let anchor = input.anchor ?? null;
    let parentId: string | null = null;

    if (input.parentId) {
      const parent = await this.row(reviewId, input.parentId);

      // Replies join the thread's root, so threads never nest.
      parentId = parent.parent_id ?? parent.id;
      anchor = null;
    }

    const id = randomUUID();

    await this.meta.run(
      `INSERT INTO review_comments(${COLUMNS}) VALUES(?,?,?,?,?,?,?,0,0,?,?)`,
      id,
      reviewId,
      version,
      anchor,
      parentId,
      input.body,
      input.author ?? "Whiteboard user",
      now,
      now,
    );

    return toComment(await this.row(reviewId, id));
  }

  async list(reviewId: string): Promise<ReviewComment[]> {
    const rows = await this.meta.all<CommentRow>(
      `SELECT ${COLUMNS} FROM review_comments WHERE review_id=? ORDER BY created_at, id`,
      reviewId,
    );

    return rows.map(toComment);
  }

  /** Resolves or reopens the whole thread a comment belongs to. */
  async setResolved(
    reviewId: string,
    commentId: string,
    resolved: boolean,
  ): Promise<ReviewComment[]> {
    const target = await this.row(reviewId, commentId);
    const root = target.parent_id ?? target.id;

    await this.meta.run(
      "UPDATE review_comments SET resolved=?,updated_at=? WHERE review_id=? AND (id=? OR parent_id=?)",
      resolved ? 1 : 0,
      new Date().toISOString(),
      reviewId,
      root,
      root,
    );

    return this.list(reviewId);
  }

  /** Moves each anchored thread to a new version. A range whose lines are
   * still in the new file follows them; otherwise the thread is outdated.
   * Runs inside the version's write transaction. */
  async carryForward(
    reviewId: string,
    version: number,
    read: { previous: LineReader; next: LineReader },
    elements: ReadonlySet<string>,
  ): Promise<void> {
    const roots = await this.meta.all<CommentRow>(
      `SELECT ${COLUMNS} FROM review_comments WHERE review_id=? AND parent_id IS NULL AND anchor IS NOT NULL AND outdated=0`,
      reviewId,
    );

    const lines = new Map<string, Promise<string[] | undefined>>();

    const linesOf = (
      source: "previous" | "next",
      side: "base" | "head",
      file: string,
    ) => {
      const key = `${source}\0${side}\0${file}`;

      if (!lines.has(key))
        lines.set(
          key,
          read[source](side, file).then((text) => text?.split("\n")),
        );

      return lines.get(key)!;
    };

    for (const root of roots) {
      const anchor = root.anchor!;
      let moved: MovedThread;

      if (anchor.startsWith("element:"))
        moved = {
          anchor,
          outdated: !elements.has(anchor.slice("element:".length)),
        };
      else {
        const selection = parseAnchor(anchor)!;
        const { side, line: start } = selection.start;
        const end = selection.end.line;
        const previous = await linesOf("previous", side, selection.file);
        const next = await linesOf("next", side, selection.file);

        const found =
          previous && next
            ? relocateLines(previous, next, start, end)
            : undefined;

        moved = found
          ? {
              anchor: formatAnchor({
                file: selection.file,
                start: { side, line: found.start },
                end: { side, line: found.end },
              }),
              outdated: false,
            }
          : { anchor, outdated: true };
      }

      await this.meta.run(
        "UPDATE review_comments SET version=?,anchor=?,outdated=? WHERE id=?",
        version,
        moved.anchor,
        moved.outdated ? 1 : 0,
        root.id,
      );
    }
  }

  private async row(reviewId: string, id: string): Promise<CommentRow> {
    const row = await this.meta.get<CommentRow>(
      `SELECT ${COLUMNS} FROM review_comments WHERE review_id=? AND id=?`,
      reviewId,
      id,
    );

    if (!row) throw new ReviewInputError("This comment was not found.", 404);

    return row;
  }
}
