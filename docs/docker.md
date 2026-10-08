# Docker

Docker Compose runs Whiteboard on `http://localhost:3000`. The port is bound to loopback on the host by default. Reviews and configuration live in the named `whiteboard-data` volume and persist across container restarts.

## Start

```sh
cp .env.example .env
printf 'PUID=%s\nPGID=%s\n' "$(id -u)" "$(id -g)" >> .env
docker compose up --build
```

The entrypoint starts as root only to prepare `/data` ownership, then runs the server as the configured unprivileged UID/GID. To stop it, use `docker compose down`; do not add `-v` if you want to retain reviews.

## Review a local repository

The current repository is mounted at `/workspace` by default. To review another checkout, set `REPOSITORY` in `.env` to its absolute host path, then recreate the container:

```dotenv
REPOSITORY=/absolute/path/to/checkout
```

For example, a repository registered in Whiteboard must use the in-container path `/workspace`. On Linux, the configured UID/GID allow Ask to write to the host checkout. The optional `~/.ssh` mount is read-only for SSH Git remotes.

## Access token and GitHub

Set `WHITEBOARD_TOKEN` in `.env` to require the same token for web/API access. Keep `.env` private; do not commit credentials. For private GitHub PRs set `GH_TOKEN`; for GitHub Enterprise set `GH_ENTERPRISE_TOKEN` and `GH_HOST`. The entrypoint configures GitHub CLI's Git credential helper for the unprivileged server account so HTTPS fetches authenticate too.

## Connect a host agent

Set `AGENT=claude` or `AGENT=codex` to include that agent CLI in the image (default `none`), and set the corresponding key, such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, in `.env`. Configure the host agent to connect to Whiteboard's MCP endpoint at `http://localhost:3000/mcp` and provide the same `WHITEBOARD_TOKEN` when prompted/configuring authorization. The host can reach the loopback-published server without running the agent inside the container.

## Upgrade

Pull the desired source revision, then rebuild and recreate:

```sh
git pull
docker compose up --build -d
```

The named data volume remains intact.

## Known limits

- The checkout must be mounted into the container; reviews store local repository paths.
- Docker binds only to host loopback by default. Use a separately configured reverse proxy for remote access.
- `AGENT` only installs the selected CLI; it does not install host-agent credentials or provide an agent service. Supply keys through `.env` and keep them secret.
- GitHub Enterprise requires a reachable `GH_HOST` and a token with repository access.
