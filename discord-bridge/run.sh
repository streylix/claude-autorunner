#!/usr/bin/env bash
# Launch the CCBOT Discord voice bridge.
#
# IMPORTANT: run this from a terminal spawned BY the auto-injector app (e.g. the
# terminal the manager opened for the build). That terminal already exports
# CCBOT_PORT and CCBOT_TOKEN, which the bridge inherits to reach terminal 999.
# Verify with:  env | grep CCBOT
#
# This process is fully standalone — starting/stopping it never touches the
# Electron app or the manager PTY.

set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "✋ No .env found. Copy .env.example to .env and fill in the 3 Discord values:"
  echo "     cp .env.example .env"
  echo "   See SETUP.md for exactly what to provide."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "📦 Installing dependencies (first run)…"
  npm install --no-audit --no-fund
fi

if [ -z "${CCBOT_PORT:-}" ] || [ -z "${CCBOT_TOKEN:-}" ]; then
  echo "⚠️  CCBOT_PORT / CCBOT_TOKEN not in this shell's env."
  echo "    Launch from an app terminal, or set them in .env. (env | grep CCBOT)"
fi

# Recommend Node 22+ (@discordjs/voice 0.19.2 declares engines >=22.12.0).
node -e 'const [maj]=process.versions.node.split(".").map(Number); if(maj<22){console.warn("⚠️  Node "+process.versions.node+" detected; @discordjs/voice 0.19.2 wants Node >=22.12.0. Modules load on 20, but prefer Node 22+ for the live voice run.")}'

echo "🚀 Starting bridge…"
exec node src/index.js
