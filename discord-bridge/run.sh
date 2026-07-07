#!/usr/bin/env bash
# Run the bridge in the FOREGROUND (dev / quick test). For the persistent
# always-on service, use ./service/install.sh instead.
#
# The bridge needs NO CCBOT credentials to start — it idles until you link a
# session in Discord with /link (key minted by the manager via
# `npm run link-key`). It only needs the Discord values in .env.

set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "✋ No .env. Copy .env.example to .env and fill in DISCORD_BOT_TOKEN + DISCORD_GUILD_ID."
  echo "   See DISCORD_SETUP_GUIDE.md."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "📦 Installing dependencies (first run)…"
  npm install --no-audit --no-fund
fi

node -e 'const [maj]=process.versions.node.split(".").map(Number); if(maj<22){console.warn("⚠️  Node "+process.versions.node+": @discordjs/voice 0.19.2 prefers Node >=22.12.0. Loads on 20; prefer Node 22+ for the live voice run.")}'

echo "🚀 Starting bridge (foreground). Ctrl-C to stop."
exec node src/index.js
