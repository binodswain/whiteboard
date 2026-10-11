# Hosted authentication

A remote deployment (`WHITEBOARD_MODE=remote`) replaces the local server
token with per-user authentication. Every route except `/health` requires an
identity; the viewer signs in through GitHub, and CLI/MCP clients use a
personal API token.

All secrets are environment variables so a Cloud Run service can bind them
from Secret Manager.

## Sign-in

Two sign-in mechanisms can coexist; at least one is required.

### GitHub OAuth

```dotenv
WHITEBOARD_AUTH_SECRET=…            # signs sessions, OAuth state, seals tokens
GITHUB_OAUTH_CLIENT_ID=…            # GitHub App client id
GITHUB_OAUTH_CLIENT_SECRET=…        # GitHub App client secret
```

Sign in through a GitHub App with the callback
`https://<host>/auth/github/callback` and only the **Metadata: read-only**
repository permission. No OAuth scope is requested: the user token carries
just the App's permissions, limited to repositories the App is installed on,
so it can answer read-access checks without write access. Configure the same
App under [GitHub App repository access](#github-app-repository-access) so
access checks keep working once a user token expires. A classic OAuth App
also works, but then only public repositories are readable. GitHub tokens
are sealed with `WHITEBOARD_AUTH_SECRET` before they reach the database, and sessions
live in `auth_sessions` (30-day expiry, `HttpOnly` cookie).

### Trusted identity proxy

Behind Google IAP, Cloudflare Access or a similar authenticating proxy the
viewer needs no OAuth flow at all:

```dotenv
WHITEBOARD_AUTH_SECRET=…
WHITEBOARD_AUTH_PROXY_HEADER=x-user-login       # header carrying the login
WHITEBOARD_AUTH_PROXY_SECRET=…                # shared with the proxy
WHITEBOARD_AUTH_PROXY_SECRET_HEADER=…          # header carrying it
                                              # (default x-whiteboard-proxy-secret)
```

A request authenticates only when the secret header matches — the login
header alone is never trusted, so the proxy must strip both from inbound
traffic and inject them itself.

## API keys

Signed-in viewers manage personal API keys in Settings → API keys
(`/auth/tokens`). A key is not an OAuth token: it is an opaque `wbt_…` secret
sent as a standard `Authorization: Bearer` header. A key is shown once at creation; the database stores only
its SHA-256 hash. Revoking a token deletes the row, so it fails on its very
next request.

```sh
curl -H "Authorization: Bearer wbt_…" https://<host>/reviews-api
whiteboard review --repo .   # sends the key as x-review-token
```

`x-review-token` and `Authorization: Bearer` are equivalent. A key
identifies its owner but cannot mint or manage further tokens — that needs a
session.

## Repository access

Every review names the repositories its content reads. Remote mode resolves
each `repositoryPath` to a canonical `webUrl/owner/repo` and checks the
caller's GitHub identity before listing or opening it:

- OAuth viewers are checked with their own GitHub token.
- Proxy users are checked through the App's collaborator endpoint, and
  public repositories read for any identity.
- Verdicts are cached in `auth_repo_access` for five minutes; transient
  GitHub failures deny but are never cached.
- A denied repository answers the same 404 as a missing review.

## GitHub App repository access

The server fetches hosted checkouts with an App installation token minted
per repository and job:

```dotenv
GITHUB_APP_ID=…
GITHUB_APP_PRIVATE_KEY=…          # PEM, base64 PEM, or \n-escaped PEM
GITHUB_APP_INSTALLATION_ID=…      # optional single-installation pin
```

Without an App, checkouts fall back to `GITHUB_TOKEN`. For GitHub
Enterprise:

```dotenv
GITHUB_WEB_URL=https://github.example.com
GITHUB_API_URL=…                  # default: <web>/api/v3
```

## Local mode

Nothing above applies to `WHITEBOARD_MODE=local` (the default): the existing
`WHITEBOARD_TOKEN` and `WHITEBOARD_LOCAL_BROWSER_AUTH` behaviour is
unchanged, and no auth secret or OAuth configuration is needed.
