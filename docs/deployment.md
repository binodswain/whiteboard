# Local and hosted deployments

Whiteboard keeps local mode as its default. `pnpm docker:up` starts the local profile: SQLite metadata, filesystem blobs, a mounted checkout, inline review preparation, and the existing local token behavior. Copy `.env.example` to `.env`, set `CODE_ROOT` to an absolute checkout path, then run `pnpm docker:up`.

For a cloud-free remote-mode stack, run `docker compose --profile remote-dev up --build` (or `pnpm docker:up --remote-dev`). This profile starts Whiteboard in remote mode with Postgres, MinIO, an automatically-created `whiteboard` bucket, and a polling job runner. Copy `.env.example` to `.env` and set optional remote values there to override the compose defaults. The development proxy identity and secret are convenience values; replace the proxy secret before exposing the stack beyond localhost. `pnpm docker:smoke:remote` mints a personal API token through the trusted proxy, then exercises the remote health response, token-authenticated review creation from a public GitHub repository, comment creation, and ask enqueue/claim/complete. Set `WHITEBOARD_URL` or `WHITEBOARD_PORT` to target another endpoint. `WHITEBOARD_SMOKE_REPOSITORY` selects a public repository; `GH_TOKEN` can be supplied to avoid GitHub's anonymous API rate limit.

## Configuration reference

| Variable | Purpose |
| --- | --- |
| `WHITEBOARD_MODE` | `local` or `remote`; defaults to `local`. |
| `WHITEBOARD_DB` | `sqlite` locally or a `postgres://` URL remotely. |
| `WHITEBOARD_BLOBS` | `fs` locally or `s3://bucket` remotely. |
| `WHITEBOARD_S3_ENDPOINT` | Optional S3-compatible endpoint, such as MinIO or Google Cloud Storage XML API. |
| `WHITEBOARD_S3_REGION`, `WHITEBOARD_S3_KEY`, `WHITEBOARD_S3_SECRET` | S3 signing region and credentials. For GCS interoperability use an HMAC access ID and secret. |
| `WHITEBOARD_REPO_SOURCE` | `local` or `github`; remote defaults to `github`. |
| `WHITEBOARD_JOBS` | `inline` or `queue`; remote defaults to `queue`. |
| `WHITEBOARD_JOB_SECRET` | Bearer secret required by `POST /internal/jobs/run`; keep the endpoint private to the job trigger. |
| `WHITEBOARD_AUTH` | `local-token` or `oauth`; remote defaults to OAuth. |
| `WHITEBOARD_AUTH_SECRET` | Signs remote sessions and OAuth state. |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | GitHub OAuth app credentials, unless an identity proxy is used. |
| `WHITEBOARD_AUTH_PROXY_HEADER`, `WHITEBOARD_AUTH_PROXY_SECRET`, `WHITEBOARD_AUTH_PROXY_SECRET_HEADER` | Trusted identity and proof headers supplied by an upstream identity proxy. |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID` | Optional GitHub App credentials for repository checkout and access checks. |
| `GH_TOKEN` | Optional GitHub token for public or private repository checkout when no GitHub App is configured. |

## Review jobs

`generate_review` accepts a local checkout in local mode or a GitHub repository and base/head commit SHAs in remote mode. Inline mode completes preparation in the request; queue mode returns a job ID that clients can poll with `review_job_status`. A queue worker invokes `POST /internal/jobs/run` with `Authorization: Bearer <WHITEBOARD_JOB_SECRET>`. The remote-dev profile runs this polling loop for local testing. A hosted job system such as Cloud Tasks can call the same route. The route is unavailable if the secret is unset.

## Cloud Run reference

`deploy/cloudrun/service.yaml` in the repository root is a starting point for a Cloud Run API service. Provision Cloud SQL for PostgreSQL, a GCS bucket, S3 interoperability HMAC credentials, and Secret Manager entries before deploying it. Grant the Cloud Run service account access to connect to Cloud SQL and read the named secrets. The manifest uses the Cloud SQL Unix socket and GCS XML endpoint; configure GCS HMAC keys as `WHITEBOARD_S3_KEY` and `WHITEBOARD_S3_SECRET`.

Configure a Cloud Tasks queue or Cloud Scheduler target to POST to `/internal/jobs/run` with the `WHITEBOARD_JOB_SECRET` bearer token. Keep that route behind authenticated task delivery or ingress restrictions. The sample manifest runs the API only; deploy a separate worker/Cloud Run Job if job throughput requires it. MCP requests are stateless and their review state is stored in Postgres, so Cloud Run does not need sticky sessions. Session signing uses the shared `WHITEBOARD_AUTH_SECRET` across replicas.

The current GitHub checkout cache lives in the server state directory at `repos/<owner>/<repository>`. Cloud Run's instance filesystem is ephemeral, and this implementation does not persist or reconstruct that checkout cache through GCS. The manifest is therefore a configuration reference, not evidence of a multi-instance Cloud Run deployment; validate checkout continuity or add a shared/persistent checkout design before relying on review reads across instance replacement.
