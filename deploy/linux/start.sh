#!/bin/bash
set -euo pipefail
args=(
  --host 127.0.0.1 --port 8765 --no-browser
  --config /etc/tracktool/config.json
  --archive "${TRACKTOOL_ARCHIVE:?请设置轨迹库目录}"
  --cache /var/cache/tracktool/maps
  --state-dir /var/lib/tracktool/state/tracktool
  --files-root /var/lib/tracktool/data
)
if [[ -n "${TRACKTOOL_PUBLIC_ORIGIN:-}" ]]; then
  args+=(--public-origin "$TRACKTOOL_PUBLIC_ORIGIN" --cloudflare-access)
fi
exec /var/lib/tracktool/.nvm/versions/node/v26.11.1/bin/node \
  /opt/tracktool/current/node_modules/tracktool/dist/node/server/main.js "${args[@]}"
