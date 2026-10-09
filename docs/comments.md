# Review comments

Comments let readers and agents discuss a review in the viewer, from the
CLI, or through MCP. They are stored per review in the same metadata store
as the review (sqlite locally, postgres when hosted), so local and hosted
modes behave the same.

## Model

- A thread has one root comment and any number of replies. Replies store the
  root's id as `parentId`, so threads never nest: a reply to a reply joins the
  root.
- A root is either anchored or unanchored. An anchor is one of:
  - a source range on one side: `head/path#L10-L12` or `base/path#L7`
    (cross-side `diff/...` anchors are rejected);
  - a diagram element: `element:<id>`;
  - nothing, meaning the whole review.
- Resolve and reopen apply to the whole thread, from any of its comments.
- The author defaults to the server user over HTTP and MCP, and to the
  checkout's `git config user.name` in the CLI.

## Re-anchoring across versions

Each new version that changes the review's pins re-checks every open,
anchored root (the write runs inside the version's transaction):

- A source range is read again at both pins. If its lines are unchanged at
  the same position, it stays. If the same block of lines now appears exactly
  once elsewhere in the file, the anchor moves there. Otherwise the comment
  is marked `outdated` and keeps its old anchor.
- An element anchor stays attached while the element id is still in the
  version's document, and is marked `outdated` once it is gone.
- Every root checked records the version it was last checked against.

Outdated threads stay open until someone resolves them. A comment already
outdated is not checked again.

## CLI

The commands sit at the top level of the `whiteboard` binary:

```sh
whiteboard comment <review> "Why two lines?" --file src/a.ts:2
whiteboard comment <review> "Agreed" --reply-to <commentId>
whiteboard comments <review>
```

- `--file <path:line>` anchors to `head/<path>#L<line>`.
- `--reply-to <commentId>` posts a reply to that comment's thread.
- `comments` prints each thread on one line with `open` or `resolved` and
  `outdated` when it applies, followed by its replies indented.

## MCP tools

Agents see these as `session_add_comment`, `session_list_comments` and
`session_resolve_comment`:

- `add_comment`: `reviewId`, `body`, optional `anchor`, optional `parentId`.
- `list_comments`: `reviewId`. Returns the flat list of comments with
  `anchor`, `parentId`, `resolved` and `outdated`.
- `resolve_comment`: `reviewId`, `commentId`, optional `resolved` (defaults
  to `true`). Returns the review's comments after the change.

## HTTP routes

Mounted under the review API, per review id:

| Method | Path                    | Body                                    | Response           |
| ------ | ----------------------- | --------------------------------------- | ------------------ |
| GET    | `/:id/comments`         | none                                    | `200 { comments }` |
| POST   | `/:id/comments`         | `{ body, author?, anchor?, parentId? }` | `201` comment      |
| POST   | `/:id/comments/resolve` | `{ commentId, resolved? }`              | `200 { comments }` |

Errors: an empty or over-long body is `400`; a `commentId` or `parentId`
that is not in this review is `404`.
