# Docker

Docker Compose runs Whiteboard on `http://localhost:3000`. The port is bound to loopback on the host by default. Reviews and configuration live in the named `whiteboard-data` volume and persist across container restarts.

## Start

```sh
cp .env.example .env
printf 'UID=%s\nGID=%s\n' "$(id -u)" "$(id -g)" >> .env
docker compose up --build
```

The server runs directly as the configured unprivileged UID/GID; the named data volume must be writable by that user. To stop it, use `docker compose down`; do not add `-v` if you want to retain reviews.

## Review a local repository

The current repository is mounted at `/workspace` by default. To review another checkout, set `REPOSITORY` in `.env` to its absolute host path, then recreate the container:

```dotenv
REPOSITORY=/absolute/path/to/checkout
```

For example, a repository registered in Whiteboard must use the in-container path `/workspace`. On Linux, the configured UID/GID allow Ask to write to the host checkout. For SSH Git remotes, configure SSH credentials in the container separately; this Compose setup does not mount host SSH keys.

## Access token and GitHub

The Docker image defaults to token authentication. This loopback-published Compose example explicitly enables tokenless local browser access with `WHITEBOARD_LOCAL_BROWSER_AUTH=1`; the web app skips its token prompt only after the server advertises this mode. Requests without a token are accepted only when `Host` is exactly `localhost`, `127.0.0.1`, or `[::1]` on the server port, and state-changing API requests must also carry the matching `http` `Origin`. Missing or foreign values are rejected; forwarded host headers are not trusted. Other API clients can continue to use `WHITEBOARD_TOKEN`.

This flag is a local-trust switch, not proof that the connecting client is on the same machine. In particular, the container's `0.0.0.0` bind does not establish whether Docker published its port only to host loopback, and Host/Origin checks do not replace network isolation. If you expose the port on a non-loopback host interface or through a proxy/tunnel, disable tokenless access by setting `WHITEBOARD_LOCAL_BROWSER_AUTH=0` in `.env` (or retain token authentication by using the Docker image without the Compose opt-in). Keep `.env` private; do not commit credentials. For private GitHub PRs set `GH_TOKEN`; for GitHub Enterprise set `GH_ENTERPRISE_TOKEN` and `GH_HOST`. The image configures Git to use GitHub CLI's credential helper, which reads the supplied token environment variables for HTTPS fetches as well as PR metadata lookup.

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
