#!/usr/bin/env bash
set -euo pipefail

container=${1:?container name required}
api() { docker exec "$container" whiteboard --state-dir /data api "$@"; }
created=$(api session_create '{"title":"Docker web smoke review","target":{"kind":"worktree","repositoryPath":"/workspace"}}')
session_id=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).sessionId)' "$created")
edit() { api session_edit "$(node -e 'process.stdout.write(JSON.stringify({sessionId:process.argv[1],edit:{type:"insert",content:JSON.parse(process.argv[2])}}))' "$session_id" "$1")" >/dev/null; }
edit '{"type":"markdown","markdown":"# Browser smoke test\n\nThis review was seeded by CI."}'
edit '{"type":"flow_diagram","title":"Queue an order","nodes":[{"key":"request","label":"Queue order"},{"key":"saved","label":"Saved","kind":"terminal"}],"edges":[{"from":"request","to":"saved","label":"persist"}]}'
edit '{"type":"sequence","title":"Order lifecycle","actors":{"api":"API","store":"Order store"},"steps":[{"from":"api","to":"store","label":"Persist order","explanation":"The order is stored."}]}'
