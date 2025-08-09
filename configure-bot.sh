#!/bin/bash

# Configure Discord Bot integration

echo "🤖 Discord Bot Configuration"
echo "============================"
echo ""

# Check if .bot-config already exists
if [ -f ".bot-config" ]; then
    source .bot-config
    echo "Current configuration:"
    echo "  BOT_DIR: $BOT_DIR"
    echo ""
    read -p "Do you want to update the configuration? (y/n): " UPDATE
    if [ "$UPDATE" != "y" ] && [ "$UPDATE" != "Y" ]; then
        echo "Configuration unchanged."
        exit 0
    fi
fi

# Prompt for bot directory
echo "Enter the path to your Discord bot directory"
echo "(Press Enter to use default: /Users/ethan/claudebot)"
read -p "Bot directory: " INPUT_DIR

# Use default if empty
BOT_DIR="${INPUT_DIR:-/Users/ethan/claudebot}"

# Verify directory exists
if [ ! -d "$BOT_DIR" ]; then
    echo "⚠️  Warning: Directory does not exist: $BOT_DIR"
    read -p "Create configuration anyway? (y/n): " CONTINUE
    if [ "$CONTINUE" != "y" ] && [ "$CONTINUE" != "Y" ]; then
        echo "Configuration cancelled."
        exit 1
    fi
fi

# Check for run_bot.sh
if [ -f "$BOT_DIR/run_bot.sh" ]; then
    echo "✅ Found run_bot.sh in $BOT_DIR"
else
    echo "⚠️  run_bot.sh not found in $BOT_DIR"
    echo "   Make sure this file exists for the bot to start"
fi

# Write configuration
cat > .bot-config << EOF
# Local bot configuration (not tracked by git)
# This file stores local paths that shouldn't be in version control

# Discord bot directory path
BOT_DIR=$BOT_DIR
EOF

echo ""
echo "✅ Configuration saved to .bot-config"
echo "   BOT_DIR=$BOT_DIR"
echo ""
echo "The Discord bot will now start automatically when you run:"
echo "  ./start_with_backend.sh"
echo ""
echo "To disable the bot, delete .bot-config or set BOT_DIR to empty"