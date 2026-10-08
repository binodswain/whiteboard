#!/bin/sh
set -eu
PUID=${PUID:-1000}
PGID=${PGID:-1000}

if ! getent group "$PGID" >/dev/null; then
  groupadd --gid "$PGID" whiteboard
fi
GROUP=$(getent group "$PGID" | cut -d: -f1)
if ! getent passwd "$PUID" >/dev/null; then
  useradd --uid "$PUID" --gid "$GROUP" --home-dir /home/whiteboard --create-home --shell /bin/sh whiteboard
fi
USER_NAME=$(getent passwd "$PUID" | cut -d: -f1)
mkdir -p /data
chown -R "$PUID:$PGID" /data
if [ -n "${GH_TOKEN:-}${GH_ENTERPRISE_TOKEN:-}" ]; then
  su -s /bin/sh "$USER_NAME" -c 'gh auth setup-git'
fi
exec setpriv --reuid "$PUID" --regid "$PGID" --init-groups "$@"
