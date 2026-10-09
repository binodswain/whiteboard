#!/usr/bin/env bash
set -euo pipefail

container=${1:?container name required}
api() { docker exec "$container" whiteboard api "$@"; }
override_dir=/tmp/whiteboard-state-override
if override_error=$(docker exec "$container" whiteboard --state-dir "$override_dir" api tools 2>&1 >/dev/null); then
  echo "Expected --state-dir to override DEV_REVIEW_SERVER_DIR." >&2
  exit 1
fi
case "$override_error" in
  *"$override_dir"*) ;;
  *) printf 'Unexpected --state-dir override error: %s\n' "$override_error" >&2; exit 1 ;;
esac
created=$(api session_create '{"title":"Docker web smoke review","target":{"kind":"worktree","repositoryPath":"/workspace"}}')
session_id=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).sessionId)' "$created")
edit() { api session_edit "$(node -e 'process.stdout.write(JSON.stringify({sessionId:process.argv[1],edit:{type:"insert",content:JSON.parse(process.argv[2])}}))' "$session_id" "$1")" >/dev/null; }
edit '{"type":"markdown","markdown":"# Browser smoke test\n\nThis review was seeded by CI."}'
edit '{"type":"flow_diagram","title":"Queue an order","nodes":[{"key":"request","label":"Queue order"},{"key":"saved","label":"Saved","kind":"terminal"}],"edges":[{"from":"request","to":"saved","label":"persist"}]}'
edit '{"type":"sequence","title":"Order lifecycle","actors":{"api":"API","store":"Order store"},"steps":[{"from":"api","to":"store","label":"Persist order","explanation":"The order is stored."}]}'
