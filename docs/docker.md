# Docker

Docker Compose runs Whiteboard on `http://localhost:${WHITEBOARD_PORT:-7421}`, bound to host loopback by default. Reviews, configuration, and the generated server token persist in the host directory `${WHITEBOARD_DATA_DIR:-$HOME/.whiteboard/docker}`. Compose uses the stable project name `whiteboard`, independent of the checkout directory.

## Start

```sh
cp .env.example .env
```

Set `CODE_ROOT` in `.env` to an absolute host directory containing the repositories you want to review. Set `UID` and `GID` to your host user IDs, then create the persistent data directory and start Compose. `pnpm docker:up` builds and starts the server, waits for health, and opens its setup page:

```sh
printf 'UID=%s\nGID=%s\n' "$(id -u)" "$(id -g)" >> .env
mkdir -p "$HOME/.whiteboard/docker"
pnpm docker:up
```

Replace the example `CODE_ROOT` in `.env` before starting. If you set `WHITEBOARD_DATA_DIR`, create that directory instead of `$HOME/.whiteboard/docker`. The server runs as the configured unprivileged UID/GID, so the bind-mounted data directory must be writable by that user. `docker compose down` stops the server but retains reviews, settings, and the token; do not remove the data directory if you want to keep them.

For a non-default port, set `WHITEBOARD_PORT` in `.env` and pass it to the startup helper so it can open the correct setup URL:

```sh
WHITEBOARD_PORT=3307 pnpm docker:up
```

## Upgrading from the `/workspace` setup

The new bind-mounted data directory replaces the old named volume. Before starting, `pnpm docker:up` copies data from `whiteboard_whiteboard-data` (or a single project-prefixed `*_whiteboard-data` volume) when the new directory has no `review-api.db`; it leaves the old volume untouched. To copy it manually:

```sh
DATA_DIR="${WHITEBOARD_DATA_DIR:-$HOME/.whiteboard/docker}"
mkdir -p "$DATA_DIR"
docker run --rm -v whiteboard_whiteboard-data:/from:ro -v "$DATA_DIR:/to" node:24-bookworm-slim sh -c 'cp -a /from/. /to/ && chown -R "$1:$2" /to' sh "$(id -u)" "$(id -g)"
```

If `WHITEBOARD_DATA_DIR` is set in `.env`, use that same path for `DATA_DIR` in the manual command.

For a project-prefixed volume, replace `whiteboard_whiteboard-data` with its name from `docker volume ls`. Do not remove the old volume until you have verified the migrated reviews. `CODE_ROOT` replaces the former `REPOSITORY` setting. Existing reviews registered with the in-container path `/workspace` keep that saved path and may need to be recreated against the same-path checkout.

## Review a local repository

`CODE_ROOT` is mounted at the same absolute path inside the container. A repository at `/Users/alice/code/service` on the host is therefore registered using `/Users/alice/code/service` in Whiteboard, not a remapped `/workspace` path. The same-path mount also allows Git worktrees to resolve `.git` metadata elsewhere under `CODE_ROOT`; Git safe-directory trust is scoped to this container image.

For linked worktrees, set `CODE_ROOT` to a directory containing both the worktree and its shared Git metadata. For example:

```dotenv
CODE_ROOT=/absolute/path/to/code
```

If `session_create` reports that a repository path is outside the mounted `CODE_ROOT`, set `CODE_ROOT` to a host directory containing that checkout, restart Compose, and continue using the checkout's unchanged absolute path inside the container. On Linux, matching `UID`/`GID` lets Whiteboard write to the host checkout. For SSH Git remotes, configure SSH credentials in the container separately; this Compose setup does not mount host SSH keys.

## Local auth and GitHub

The Docker image defaults to token authentication. Compose enables local auth with `WHITEBOARD_LOCAL_BROWSER_AUTH=1`; the web app skips its token prompt only after the server advertises this mode. A tokenless request to `/reviews-api`, `/mcp`, or `/control` is accepted only when `Host` is exactly `localhost`, `127.0.0.1`, or `[::1]` on the server port. If an `Origin` header is present, it must be exactly `http://<Host>`; an absent `Origin` is allowed for any method, including host-side MCP clients. `/health` remains readable without a token, and local-auth requests can read its full server details. Requests with a valid `WHITEBOARD_TOKEN` continue to work regardless of `Host` or `Origin`.

This flag is a local-trust switch, not proof that the connecting client is on the same machine. In particular, the container's `0.0.0.0` bind does not establish whether Docker published its port only to host loopback, and Host/Origin checks do not replace network isolation. If you expose the port on a non-loopback host interface or through a proxy/tunnel, disable tokenless access by setting `WHITEBOARD_LOCAL_BROWSER_AUTH=0` in `.env` and use `WHITEBOARD_TOKEN`. Keep `.env` private; do not commit credentials. For private GitHub PRs set `GH_TOKEN`; for GitHub Enterprise set `GH_ENTERPRISE_TOKEN` and `GH_HOST`. The image configures Git to use GitHub CLI's credential helper, which reads the supplied token environment variables for HTTPS fetches as well as PR metadata lookup.

## Connect a host agent

Keep the coding agent on the host; it does not need to run in the container. Register the server's HTTP MCP endpoint as the primary connection:

```sh
claude mcp add --transport http whiteboard http://localhost:7421/mcp
```

For Codex, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.whiteboard]
url = "http://localhost:7421/mcp"
```

Compose enables local auth by default, so loopback connections need no token. With token auth, add `--header "Authorization: Bearer <token>"` to the Claude command. For Codex, set `WHITEBOARD_TOKEN` in its environment and add `bearer_token_env_var = "WHITEBOARD_TOKEN"` to the MCP server table. Change `7421` to your configured `WHITEBOARD_PORT`. HTTP MCP resolves repository paths from the agent's MCP roots; pass `repositoryPath` as the absolute host path when the client does not provide a usable root. As an optional alternative, the host-side stdio process remains available with `claude mcp add whiteboard -- npx -y @dev.fast/whiteboard mcp`. The `/setup` page shows the server's actual URL and commands.

## Upgrade

Pull the desired source revision, then rebuild and recreate:

```sh
git pull
pnpm docker:up
```

The bind-mounted data directory and its generated token remain intact across container recreation and `docker compose down`/`up`.

## Known limits

- Every repository to review must be available beneath `CODE_ROOT`, mounted at the same absolute path in the container.
- Docker binds only to host loopback by default. Use a separately configured reverse proxy for remote access.
- `AGENT` only installs an optional CLI in the image; it does not start an agent service. The coding agent and its MCP process should run on the host.
- GitHub Enterprise requires a reachable `GH_HOST` and a token with repository access.
