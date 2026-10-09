#!/usr/bin/env bash
# Bring the Whiteboard Docker server up and open its setup page.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed or not on PATH." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "docker compose is not available." >&2
  exit 1
fi

if ! "${COMPOSE[@]}" up -d --build; then
  echo "docker compose failed. If CODE_ROOT is unset, export it or add it to .env (see .env.example)." >&2
  exit 1
fi

# Ask the container for its published port when possible; WHITEBOARD_PORT and
# the compose default cover builds that do not report one.
PORT="${WHITEBOARD_PORT:-}"
if [ -z "$PORT" ]; then
  PUBLISHED="$("${COMPOSE[@]}" port whiteboard 3000 2>/dev/null || true)"
  PORT="${PUBLISHED##*:}"
fi
PORT="${PORT:-3000}"

BASE_URL="http://localhost:${PORT}"

deadline=$((SECONDS + 120))
until curl -fsS -o /dev/null "${BASE_URL}/health" 2>/dev/null; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "Whiteboard did not answer ${BASE_URL}/health within 120s." >&2
    echo "Check '${COMPOSE[*]} logs whiteboard' for details." >&2
    exit 1
  fi
  sleep 2
done

SETUP_URL="${BASE_URL}/setup"
echo "Whiteboard is up at ${BASE_URL}"

case "$(uname -s)" in
  Darwin)
    open "$SETUP_URL"
    ;;
  Linux)
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$SETUP_URL" >/dev/null 2>&1 || true
    else
      echo "Open ${SETUP_URL}"
    fi
    ;;
  *)
    echo "Open ${SETUP_URL}"
    ;;
esac
