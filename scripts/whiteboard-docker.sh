#!/usr/bin/env bash
# Bring the Whiteboard Docker server up and open its setup page.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROFILE=local
REMOTE_DEV=0
if [ "${1:-}" = "--remote-dev" ]; then
  PROFILE=remote-dev
  REMOTE_DEV=1
  shift
fi
if [ "$#" -gt 0 ]; then
  echo "Usage: scripts/whiteboard-docker.sh [--remote-dev]" >&2
  exit 2
fi

dotenv_value() {
  local name="$1" line value resolved=""

  [ -f "$ROOT/.env" ] || return 0

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ "$line" == export\ * ]] && line="${line#export }"

    if [[ "$line" =~ ^${name}[[:space:]]*=(.*)$ ]]; then
      value="${BASH_REMATCH[1]}"
      value="${value#"${value%%[![:space:]]*}"}"

      if [[ "$value" == \"* ]]; then
        value="${value#\"}"
        value="${value%%\"*}"
      elif [[ "$value" == \'* ]]; then
        value="${value#\'}"
        value="${value%%\'*}"
      else
        value="${value%%[[:space:]]#*}"
        value="${value%"${value##*[![:space:]]}"}"
      fi

      value="${value//\$\{HOME\}/$HOME}"
      value="${value//\$HOME/$HOME}"
      resolved="$value"
    fi
  done < "$ROOT/.env"

  printf '%s' "$resolved"
}

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

compose_value() {
  local name="$1" environment value

  case "$name" in
    CODE_ROOT)
      if [ "${CODE_ROOT+x}" = x ]; then
        printf '%s' "$CODE_ROOT"
        return
      fi
      ;;
    WHITEBOARD_DATA_DIR)
      if [ "${WHITEBOARD_DATA_DIR+x}" = x ]; then
        printf '%s' "$WHITEBOARD_DATA_DIR"
        return
      fi
      ;;
    WHITEBOARD_PORT)
      if [ "${WHITEBOARD_PORT+x}" = x ]; then
        printf '%s' "$WHITEBOARD_PORT"
        return
      fi
      ;;
  esac

  if environment="$("${COMPOSE[@]}" config --environment 2>/dev/null)"; then
    if value="$(printf '%s\n' "$environment" | awk -F= -v name="$name" '$1 == name { sub(/^[^=]*=/, ""); print; found=1; exit } END { if (!found) exit 1 }')"; then
      printf '%s' "$value"
      return
    fi
  fi

  dotenv_value "$name"
}

WHITEBOARD_PORT_VALUE="$(compose_value WHITEBOARD_PORT)"
export WHITEBOARD_PORT="$WHITEBOARD_PORT_VALUE"

if [ "$REMOTE_DEV" -eq 0 ]; then
  CODE_ROOT_VALUE="$(compose_value CODE_ROOT)"
  if [ -z "$CODE_ROOT_VALUE" ]; then
    echo "CODE_ROOT must be set to an absolute host directory in the environment or .env." >&2
    exit 1
  fi
  case "$CODE_ROOT_VALUE" in
    /*) ;;
    *)
      echo "CODE_ROOT must be an absolute host directory; received: $CODE_ROOT_VALUE" >&2
      exit 1
      ;;
  esac
  export CODE_ROOT="$CODE_ROOT_VALUE"

  DATA_DIR="$(compose_value WHITEBOARD_DATA_DIR)"
  DATA_DIR="${DATA_DIR:-${HOME}/.whiteboard/docker}"
  case "$DATA_DIR" in
    /*) ;;
    *) DATA_DIR="$ROOT/$DATA_DIR" ;;
  esac

  mkdir -p "$DATA_DIR"
  if [ ! -w "$DATA_DIR" ]; then
    echo "Whiteboard data directory is not writable by this user: $DATA_DIR" >&2
    exit 1
  fi

  if [ ! -f "$DATA_DIR/review-api.db" ]; then
    VOLUME_NAMES="$(docker volume ls --format '{{.Name}}')" || {
      echo "Could not inspect Docker volumes for an existing Whiteboard data volume." >&2
      exit 1
    }
    LEGACY_VOLUME=""
    LEGACY_CANDIDATES=()

    while IFS= read -r volume; do
      case "$volume" in
        whiteboard_whiteboard-data)
          LEGACY_VOLUME="$volume"
          break
          ;;
        *_whiteboard-data)
          LEGACY_CANDIDATES+=("$volume")
          ;;
      esac
    done <<< "$VOLUME_NAMES"

    if [ -z "$LEGACY_VOLUME" ]; then
      case "${#LEGACY_CANDIDATES[@]}" in
        1) LEGACY_VOLUME="${LEGACY_CANDIDATES[0]}" ;;
        0) ;;
        *)
          printf 'Multiple legacy Whiteboard data volumes exist: %s. Set WHITEBOARD_DATA_DIR or migrate one volume manually.\n' "${LEGACY_CANDIDATES[*]}" >&2
          exit 1
          ;;
      esac
    fi

    if [ -n "$LEGACY_VOLUME" ]; then
      echo "Migrating Whiteboard reviews from Docker volume '$LEGACY_VOLUME' to '$DATA_DIR'."
      if ! docker run --rm \
        --volume "$LEGACY_VOLUME:/from:ro" \
        --volume "$DATA_DIR:/to" \
        node:24-bookworm-slim \
        sh -c 'cp -a /from/. /to/ && chown -R "$1:$2" /to' \
        sh "$(id -u)" "$(id -g)"; then
        echo "Legacy data migration failed; the original volume was left intact." >&2
        exit 1
      fi
      echo "Legacy Whiteboard data was copied; the original volume was left intact."
    fi
  fi
fi

if ! "${COMPOSE[@]}" --profile "$PROFILE" up -d --build; then
  echo "docker compose failed." >&2
  exit 1
fi

# Ask the container for its published port when possible; WHITEBOARD_PORT and
# the compose default cover builds that do not report one.
PORT="$WHITEBOARD_PORT_VALUE"
if [ -z "$PORT" ]; then
  PUBLISHED="$("${COMPOSE[@]}" port whiteboard 7421 2>/dev/null || true)"
  PORT="${PUBLISHED##*:}"
fi
PORT="${PORT:-7421}"

BASE_URL="http://localhost:${PORT}"

deadline=$((SECONDS + 120))
until curl -fsS -o /dev/null "${BASE_URL}/health" 2>/dev/null; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "Whiteboard did not answer ${BASE_URL}/health within 120s." >&2
    SERVICE=whiteboard
    [ "$REMOTE_DEV" -eq 0 ] || SERVICE=whiteboard-remote
    echo "Check '${COMPOSE[*]} --profile $PROFILE logs $SERVICE' for details." >&2
    exit 1
  fi
  sleep 2
done

echo "Whiteboard is up at ${BASE_URL}"

if [ "$REMOTE_DEV" -eq 1 ]; then
  echo "Remote-dev stack is ready (Postgres, MinIO, and job runner included)."
  exit 0
fi

SETUP_URL="${BASE_URL}/setup"

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
