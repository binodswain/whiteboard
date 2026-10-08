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
 && pnpm --filter @dev.fast/whiteboard deploy --prod /out

FROM node:24-bookworm-slim AS runtime-base
RUN apt-get update && apt-get install -y --no-install-recommends git gh ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory /workspace \
 && git config --system credential.helper '!gh auth git-credential'
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --from=build --chown=node:node /app/packages/review/app/dist/web ./web
RUN ln -s /app/dist/cli.js /usr/local/bin/whiteboard && chmod 755 /app/dist/cli.js \
 && mkdir -p /data && chmod 1777 /data
VOLUME /data /workspace
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
ENV HOME=/tmp
CMD ["whiteboard", "server", "start", "--host", "0.0.0.0", "--port", "3000", "--web", "/app/web", "--state-dir", "/data"]

FROM runtime-base AS runtime
ARG AGENT=none
USER root
RUN if [ "$AGENT" = claude ]; then npm install -g @anthropic-ai/claude-code; elif [ "$AGENT" = codex ]; then npm install -g @openai/codex; elif [ "$AGENT" != none ]; then echo "AGENT must be claude, codex, or none" >&2; exit 1; fi
USER node
