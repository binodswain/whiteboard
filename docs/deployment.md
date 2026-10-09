# Local and hosted deployments

Whiteboard defaults to local mode. `WHITEBOARD_MODE=local` selects SQLite metadata, filesystem blobs, the local checkout, inline review preparation, and local token authentication. This is the Docker default and requires no additional service.

Remote deployments set `WHITEBOARD_MODE=remote` and select their drivers with `WHITEBOARD_DB`, `WHITEBOARD_BLOBS`, `WHITEBOARD_REPO_SOURCE`, `WHITEBOARD_JOBS`, and `WHITEBOARD_AUTH`. The database value is a `postgres://` URL; blob storage accepts `s3://bucket` with `WHITEBOARD_S3_REGION`, `WHITEBOARD_S3_KEY`, and `WHITEBOARD_S3_SECRET` (and optional `WHITEBOARD_S3_ENDPOINT`). Remote defaults use GitHub repositories and queued jobs.

## Review preparation jobs

The `generate_review` MCP tool accepts a local repository path or GitHub `owner/repository`, plus base and head commit SHAs. Inline mode completes the review preparation in the request and returns its review ID. Queue mode returns a job ID; poll with `review_job_status`. Queue workers call `POST /internal/jobs/run` with `Authorization: Bearer <WHITEBOARD_JOB_SECRET>`. Set the same strong `WHITEBOARD_JOB_SECRET` on the API and worker service, and keep the route private to the queue provider. Without that setting the worker route is unavailable.

GitHub checkouts persist under the server state directory at `repos/<owner>/<repository>` so review pins remain available after a job completes. All replicas that need to read those reviews must share that path; rebuilding a missing checkout on another replica is not currently supported.
