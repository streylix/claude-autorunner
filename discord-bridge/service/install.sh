#!/usr/bin/env bash
# Install the bridge as a systemd --user service so it runs persistently and
# survives the auto-injector app restarting. Safe to re-run (idempotent).
#
# Usage:  ./service/install.sh        # install, enable, start
#         ./service/install.sh --boot # also start at boot/login (enable-linger)

set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"   # discord-bridge/
UNIT_SRC="$HERE/service/ccbot-discord-bridge.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_DST="$UNIT_DIR/ccbot-discord-bridge.service"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "❌ systemd not available. Use the nohup fallback instead:"
  echo "     nohup node $HERE/src/index.js > $HERE/bridge.log 2>&1 &"
  exit 1
fi

if [ ! -f "$HERE/.env" ]; then
  echo "❌ $HERE/.env not found. Copy .env.example to .env and fill in the Discord values first."
  exit 1
fi

if [ ! -d "$HERE/node_modules" ]; then
  echo "📦 Installing dependencies first…"
  ( cd "$HERE" && npm install --no-audit --no-fund )
fi

NODE_BIN="$(command -v node)"
echo "Using node: $NODE_BIN ($("$NODE_BIN" -v))"
case "$("$NODE_BIN" -v)" in
  v2[2-9].*|v[3-9][0-9].*) : ;;
  *) echo "⚠️  @discordjs/voice prefers Node >=22.12.0. Modules load on this version, but Node 22+ is recommended for the live voice run." ;;
esac

mkdir -p "$UNIT_DIR"
sed -e "s#__WORKDIR__#$HERE#g" -e "s#__NODE__#$NODE_BIN#g" "$UNIT_SRC" > "$UNIT_DST"
echo "✅ wrote $UNIT_DST"

systemctl --user daemon-reload
systemctl --user enable --now ccbot-discord-bridge.service

if [ "${1:-}" = "--boot" ]; then
  # Let the user service run even when not logged in (and start at boot).
  loginctl enable-linger "$USER" && echo "✅ lingering enabled ($USER) — service runs at boot."
fi

echo
echo "✅ Installed and started. Useful commands:"
echo "   systemctl --user status  ccbot-discord-bridge"
echo "   journalctl --user -u ccbot-discord-bridge -f   # live logs"
echo "   systemctl --user restart ccbot-discord-bridge"
echo "   systemctl --user stop    ccbot-discord-bridge"
