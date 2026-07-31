#!/usr/bin/env bash
# Remove the systemd --user service.
set -euo pipefail
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
systemctl --user stop ccbot-discord-bridge.service 2>/dev/null || true
systemctl --user disable ccbot-discord-bridge.service 2>/dev/null || true
rm -f "$UNIT_DIR/ccbot-discord-bridge.service"
systemctl --user daemon-reload 2>/dev/null || true
echo "✅ ccbot-discord-bridge service removed. (Lingering, if enabled, left as-is: loginctl disable-linger $USER)"
