# Automatic PR reviews

A hosted Whiteboard can react to GitHub pull requests: when an opted-in PR is
opened, reopened or pushed to, Whiteboard prepares a review pinned to that
exact head commit and links it from a GitHub check run.

This is opt-in and remote-only. A deployment without
`WHITEBOARD_GITHUB_WEBHOOK_SECRET` mounts nothing, and local mode is unchanged.

**What exists today:** the webhook receiver, one prepared review per head, the
check run that links it, and an opt-in written summary from a locked-down ask
runner (see below). Without it, the completed check is `neutral` and says the
review is ready without an authored summary.

## Configuration

Secrets and how the server is reached are deployment environment. Which
repositories are reviewed, and the model that writes summaries, can instead be
set by an admin in the app: list GitHub logins in `WHITEBOARD_ADMINS` (OAuth
sign-in required), and they get a **Pull request reviews** section on the
settings page. What they save is kept in the `admin_settings` table and wins
over the environment values, which stay the defaults; it applies to the next
delivery without a restart. The reviewer's API key is encrypted with
`WHITEBOARD_AUTH_SECRET` and never sent back to a browser.

| Variable                                  | Meaning                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `WHITEBOARD_GITHUB_WEBHOOK_SECRET`        | Turns the feature on. Must match the App's webhook secret.                                                             |
| `WHITEBOARD_PR_REVIEW_REPOS`              | Comma-separated `owner/repo` allowlist. Required unless `WHITEBOARD_ADMINS` is set.                                    |
| `WHITEBOARD_ADMINS`                       | Comma-separated GitHub logins who edit these settings in the app.                                                      |
| `WHITEBOARD_PR_REVIEW_DRAFTS`             | `true` to review draft PRs. Skipped by default.                                                                        |
| `WHITEBOARD_PR_REVIEW_AUTHORING`          | `true` to have an ask runner write a summary of each prepared review (see below). Off by default.                      |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | Required. The same App that checks repositories out. Set `GITHUB_APP_INSTALLATION_ID` to accept one installation only. |
| `WHITEBOARD_PUBLIC_URL`                   | Required. The origin readers use to reach this deployment; check links are `<origin>/r/<review id>`, with no token.    |
| `WHITEBOARD_REPO_SOURCE`                  | Must be `github` (the default for a remote deployment). github.com only: GitHub Enterprise is not supported.           |
| `WHITEBOARD_JOBS`                         | Must be `queue`: a delivery is answered before its review is prepared.                                                 |

Give the GitHub App the `pull_requests: read` and `checks: write` permissions,
give it `contents: read` (it resolves each PR's fork point), subscribe it to **Pull request** events, and point its webhook at
`POST /integrations/github/webhook`. Check updates use an installation token
narrowed to `checks: write` on the one repository.

## What happens to a delivery

1. The signature (`X-Hub-Signature-256`) is checked against the raw body. A bad
   signature is rejected before anything is read or queued.
2. Only `opened`, `reopened` and `synchronize` on an allowlisted repository and
   installation are acted on. Anything else is answered `200` and its reason is
   kept in `github_deliveries`.
3. One run is stored per `(installation, repository, PR, head SHA)`. One
   delivery claims the run, creates the check run for that head, resolves the
   PR's fork point through GitHub's compare API (the event's `base.sha` is the
   base branch's tip, which would show newer base commits as reverted), and
   queues a `prepare_review` job. A repeated or concurrent delivery for the
   same head finds the run taken and adds nothing.
4. The job checks out the fork point and head, creates a review linked to the
   PR URL (a retry finds the head's existing review instead of making another),
   and the check run is completed with `details_url` set to
   `WHITEBOARD_PUBLIC_URL/r/<review id>`. The run only leaves `preparing` once
   GitHub accepted that update, so a rejected update is retried. Each head gets its own review, even when an earlier head of the same
   PR already has one.
5. A failed job completes the check as `failure` with fixed text. Error details
   stay in the run row (`pr_review_runs.error`), never in check output.
   Redelivering the webhook (or pushing a new commit) retries it.

## Written summary (opt-in)

With `WHITEBOARD_PR_REVIEW_AUTHORING=true` (or the summary switch on the
settings page), a prepared review is not completed
at once. The run moves to `authoring` and a hosted ask is queued with a fixed,
server-owned prompt: read the change through the review's Whiteboard tools, and
post one whole-review comment whose first line is `## Pull request summary [<code>]`.
The code is derived from a server secret and the run, so a comment from anyone
else is never taken for the summary.
The prompt marks the diff and comments as untrusted data to describe, never
instructions. When the ask ends, the check is completed as `neutral` with that
comment (cut to 4000 characters) as its summary and `details_url` on the
review.

The review is already usable at that point, so a failed ask, an ask with no
summary comment, or no runner picking it up within 30 minutes still completes
the check with the plain "Review ready" text. An ask that is given up on is
cancelled so a runner arriving later does not run it. Turning the setting off
also completes runs still waiting. The server checks for finished asks every
30 seconds.

These asks have kind `pr-review`. A connector takes only `interactive` asks
unless started with `--kind pr-review`, so a laptop connector never runs them.

### The pull request runner

```sh
whiteboard connect --server https://whiteboard.example.com --agent pi \
  --kind pr-review --once --model <model> [--provider <provider>]
```

`--model` and `--provider` default to `WHITEBOARD_PR_MODEL` and
`WHITEBOARD_PR_PROVIDER`. When admins are configured, only an admin's API
token can see or claim pull request asks, and the claim carries the provider,
model and key saved on the settings page; those win over the runner's own.
With `--kind pr-review` the runner:

- refuses to start unless the agent has a locked-down mode, is installed and
  can take Whiteboard's MCP tools, and fails an ask when neither the server
  nor its environment gives it a provider key. Only Pi has one today:
  it runs with read-only local tools (`read,grep,find,ls`), no extensions and
  no saved session;
- starts the agent with only `PATH`, `HOME`, locale and CA variables and the
  provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `GEMINI_API_KEY`). The runner's own token and other secrets are not passed;
- gives the agent a per-ask token (`wba_…`) issued at claim. It reaches only
  that ask's review — its reads, comments, progress, activity and edits — and
  stops working when the ask ends or its lease runs out. Other reviews,
  listings, the ask queue and settings answer `403`;
- runs the agent in a fresh temporary directory holding `PR_DIFF.patch`,
  `CHANGED_FILES.txt` and the changed files' head contents under `head/`
  (fetched through the per-ask token and size-capped), and deletes it after;
- fails an ask that runs past `--max-runtime` minutes (15 by default);
- with `--once`, exits after one ask so nothing carries over between PRs.

The production compose file has a `reviewer` service for this, off unless
started with `--profile reviewer`. It reads `.env.reviewer` (an admin's API
token as `WHITEBOARD_TOKEN`), runs read-only with dropped
capabilities and a `/tmp` tmpfs, and mounts no data volume or GitHub key.
Build its image with `AGENTS=pi`; the Dockerfile installs pinned agent
versions.

The VM deploy workflow builds with `AGENTS=pi` and starts the reviewer when
the `WHITEBOARD_REVIEWER_TOKEN` secret is set, writing `.env.reviewer` from it
alone; the provider and key are set on the settings page. It passes the
`WHITEBOARD_ADMINS` repository variable to the server. Without the token it
stops any reviewer left running.

## Cleanup

When a run finishes, its review's pinned checkouts are removed; they are
rebuilt if someone opens the review's files later. Once a day the server
deletes `github_deliveries` rows older than seven days and runs
`git worktree prune` and `git gc --auto` on each cached clone, skipping a clone
that is being prepared. Clones themselves are kept: reviews read from them.

Preparations of one repository take turns on its clone through a file lock
that is renewed while held, so a long preparation is not taken over.

A `synchronize` marks the PR's older runs `superseded`. Each run only ever
updates its own check run, so an old head finishing late cannot change the
newest head's result.

## Fork pull requests

Fork PRs are not supported yet. Whiteboard fetches the pinned commits from the
base repository, which does not reliably have a fork's commits. The run is
recorded as `unsupported` (see `github_deliveries.outcome`), no review is
created, and a `neutral` check explaining this is created for the head commit
in one call.

GitHub's Checks API associates a check with a PR by pushes to the repository
the check was created in, so that check may not appear on the fork PR's page.
The delivery outcome is the dependable record until fork PRs are supported.

## Recovery

GitHub does not redeliver failed webhooks. A run stored but never dispatched
(for example the process exited in between) is picked up by the next worker
pass once it has been idle for a minute, and a prepared review whose check
update GitHub rejected is retried by later passes. A failed run is retried by
redelivering its webhook or pushing a new commit.

## Data flow

Webhook payloads are read for identifiers (repository, PR number, SHAs,
installation) only; PR titles, descriptions and branch names are not stored or
used. The review itself is prepared from the repository checkout as for any
hosted review. Preparing sends nothing to a model provider. With the written
summary on, the runner sends the PR's diff, changed files and review content
to the configured provider.
