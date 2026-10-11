# Automatic PR reviews

A hosted Whiteboard can react to GitHub pull requests: when an opted-in PR is
opened, reopened or pushed to, Whiteboard prepares a review pinned to that
exact head commit and links it from a GitHub check run.

This is opt-in and remote-only. A deployment without
`WHITEBOARD_GITHUB_WEBHOOK_SECRET` mounts nothing, and local mode is unchanged.

**What exists today:** the webhook receiver, one prepared review per head, and
the check run that links it. The AI authoring step (a hosted Pi worker writing
the summary and diagrams) is not wired in yet, so the completed check is
`neutral` and says the review is ready without an authored summary.

## Configuration

All of it is deployment environment, never repository files.

| Variable                                  | Meaning                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `WHITEBOARD_GITHUB_WEBHOOK_SECRET`        | Turns the feature on. Must match the App's webhook secret.                                                             |
| `WHITEBOARD_PR_REVIEW_REPOS`              | Comma-separated `owner/repo` allowlist. Required.                                                                      |
| `WHITEBOARD_PR_REVIEW_DRAFTS`             | `true` to review draft PRs. Skipped by default.                                                                        |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | Required. The same App that checks repositories out. Set `GITHUB_APP_INSTALLATION_ID` to accept one installation only. |
| `WHITEBOARD_JOBS`                         | Must be `queue`: a delivery is answered before its review is prepared.                                                 |

Give the GitHub App the `pull_requests: read` and `checks: write` permissions,
subscribe it to **Pull request** events, and point its webhook at
`POST /integrations/github/webhook`. Check updates use an installation token
narrowed to `checks: write` on the one repository.

## What happens to a delivery

1. The signature (`X-Hub-Signature-256`) is checked against the raw body. A bad
   signature is rejected before anything is read or queued.
2. Only `opened`, `reopened` and `synchronize` on an allowlisted repository and
   installation are acted on. Anything else is answered `200` and its reason is
   kept in `github_deliveries`.
3. One run is stored per `(installation, repository, PR, head SHA)`, a check run
   is created for that head, and a `prepare_review` job is queued. A repeated
   delivery, or a second event for the same head, finds the existing run and
   adds nothing.
4. The job checks out the event's base and head SHAs, creates a review linked to
   the PR URL, and the check run is completed with `details_url` set to that
   review. Each head gets its own review, even when an earlier head of the same
   PR already has one.
5. A failed job completes the check as `failure` with fixed text. Error details
   stay in the run row (`pr_review_runs.error`), never in check output.
   Redelivering the webhook (or pushing a new commit) retries it.

A `synchronize` marks the PR's older runs `superseded`. Each run only ever
updates its own check run, so an old head finishing late cannot change the
newest head's result.

## Fork pull requests

Fork PRs are not supported yet. Whiteboard fetches the pinned commits from the
base repository, which does not reliably have a fork's commits. The check
completes `neutral` and says so, and no review is created.

## Data flow

Webhook payloads are read for identifiers (repository, PR number, SHAs,
installation) only; PR titles, descriptions and branch names are not stored or
used. The review itself is prepared from the repository checkout as for any
hosted review. Nothing is sent to a model provider by this step.
