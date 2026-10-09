# Hosted asks

Remote Whiteboard boards submit asks to the metadata-backed queue and poll the
ask record for `pending`, `running`, `done`, or `failed`. A laptop connector
claims work through short HTTP requests, then gives the selected agent a
stateless MCP connection to the hosted server. The default local server path
continues to use its in-process streaming agent.

Start one connector on a laptop with an installed Claude Code agent:

```sh
whiteboard connect --server https://whiteboard.example.com --token "$WHITEBOARD_TOKEN"
```

Use `--agent codex`, `--agent cursor`, `--agent opencode`, or `--agent pi` to
select another installed CLI. `WHITEBOARD_TOKEN` is an existing server token
setting; the connector also accepts it through `--token`. Each claim has a
10-minute lease. If a connector exits during a run, the server makes the ask
available again after the lease expires, up to five attempts.

The queue API is mounted under `/reviews-api`:

- `POST /asks` with `{ reviewId, prompt }` creates an ask.
- `GET /asks/:id` returns status and result references.
- `GET /asks/pending` lists work available to connectors.
- `POST /asks/:id/claim` with `{ runnerId }` claims one ask atomically.
- `POST /asks/:id/complete` with `{ runnerId, resultRefs }` records success.
- `POST /asks/:id/fail` with `{ runnerId, error }` records failure.

All calls use the same `x-review-token` authentication as the review API.
Remote asks do not use WebSockets or server-sent events.
