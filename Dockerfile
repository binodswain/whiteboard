# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @dev.fast/whiteboard... --filter @dev.fast/review-canvas...
RUN pnpm --filter @dev.fast/whiteboard build \
 && pnpm --filter @dev.fast/review-canvas build:web \
 && pnpm --filter @dev.fast/whiteboard deploy --prod --legacy /out \
 && apt-get update && apt-get install -y --no-install-recommends binutils \
 && rm -rf /var/lib/apt/lists/* \
 && strip /out/node_modules/@dev.fast/diffr-*/diffr \
 && rm -rf /out/src \
 && find /out -type f \( -name '*.map' -o -name '*.d.ts' \) -delete

FROM node:24-bookworm-slim AS runtime-base
RUN apt-get update && apt-get install -y --no-install-recommends git gh ca-certificates \
 && dpkg --remove --force-depends perl perl-modules-5.36 libperl5.36 \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man /usr/share/locale \
 && git config --system --add safe.directory '*' \
 && git config --system credential.helper '!gh auth git-credential'
ENV NODE_ENV=production
ENV DEV_REVIEW_SERVER_DIR=/data
ENV WHITEBOARD_PORT=7421
ENV WHITEBOARD_MODE=local
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --from=build --chown=node:node /app/packages/review/app/dist/web ./web
RUN ln -s /app/dist/cli.js /usr/local/bin/whiteboard && chmod 755 /app/dist/cli.js \
 && mkdir -p /data && chmod 1777 /data
VOLUME /data
EXPOSE 7421
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + process.env.WHITEBOARD_PORT + '/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
ENV HOME=/tmp
ENV WHITEBOARD_LOCAL_BROWSER_AUTH=0
CMD ["sh", "-c", "exec whiteboard server start --host 0.0.0.0 --port ${WHITEBOARD_PORT:-7421} --web /app/web"]

FROM runtime-base AS runtime
# AGENTS is a comma- or space-separated list of agent CLIs to install, at
# pinned versions; AGENT is the older single-agent form.
ARG AGENT=none
ARG AGENTS=
ARG CLAUDE_CODE_VERSION=2.1.296
ARG CODEX_VERSION=0.162.1
ARG PI_VERSION=1.1.0
USER root
RUN set -e; \
    for agent in $(echo "${AGENTS:-$AGENT}" | tr ',' ' '); do \
      case "$agent" in \
        none) ;; \
        claude) npm install -g "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION" ;; \
        codex) npm install -g "@openai/codex@$CODEX_VERSION" ;; \
        pi) npm install -g "@earendil-works/pi-coding-agent@$PI_VERSION" ;; \
        *) echo "AGENTS entries must be claude, codex, pi, or none" >&2; exit 1 ;; \
      esac; \
    done; \
    npm cache clean --force
USER node
