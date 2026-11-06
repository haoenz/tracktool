#!/bin/bash
set -euo pipefail
backup=/var/lib/tracktool/backups/tracktool-$(date -u +%Y%m%dT%H%M%S%NZ).sqlite3
exec /var/lib/tracktool/.nvm/versions/node/v26.11.1/bin/node \
  /opt/tracktool/current/node_modules/tracktool/dist/node/cli/main.js \
  archive full-backup --config /etc/tracktool/config.json \
  --archive "${TRACKTOOL_ARCHIVE:?请设置轨迹库目录}" --output "$backup"
