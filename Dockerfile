# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @dev.fast/whiteboard... --filter @dev.fast/review-canvas...
RUN pnpm --filter @dev.fast/whiteboard build && pnpm --filter @dev.fast/review-canvas exec vite build --config web.vite.config.ts

FROM node:24-bookworm-slim AS runtime-base
RUN apt-get update && apt-get install -y --no-install-recommends git gh util-linux ca-certificates curl && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory /workspace
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/packages/review/dist ./node_modules/@dev.fast/whiteboard/dist
COPY --from=build /app/packages/review/app/dist/web ./web
COPY --from=build /app/packages/review/package.json ./node_modules/@dev.fast/whiteboard/package.json
COPY --from=build /app/packages/review/node_modules ./node_modules/@dev.fast/whiteboard/node_modules
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && npm install --global --omit=dev /app/packages/review
VOLUME /data /workspace
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["whiteboard", "server", "start", "--host", "0.0.0.0", "--port", "3000", "--web", "/app/web", "--state-dir", "/data"]

FROM runtime-base AS runtime
ARG AGENT=none
RUN if [ "$AGENT" = claude ]; then npm install -g @anthropic-ai/claude-code; elif [ "$AGENT" = codex ]; then npm install -g @openai/codex; elif [ "$AGENT" != none ]; then echo "AGENT must be claude, codex, or none" >&2; exit 1; fi
