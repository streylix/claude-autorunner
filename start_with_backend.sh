#!/bin/bash

# Start both Django backend and Auto-Injector app
# This script starts the Django backend first, then the Auto-Injector app

echo "🚀 Starting Terminal GUI with Django Backend..."

# Function to cleanup background processes
cleanup() {
    echo "🧹 Cleaning up background processes..."
    if [ -n "$BACKEND_PID" ]; then
        kill $BACKEND_PID 2>/dev/null
    fi
    if [ -n "$BOT_PID" ]; then
        kill $BOT_PID 2>/dev/null
    fi
    exit 0
}

# Set up signal handlers
trap cleanup SIGINT SIGTERM

# Start Django backend in background
echo "📡 Starting Django backend on port 8001..."
cd backend
source venv/bin/activate
python manage.py runserver 127.0.0.1:8001 --noreload &
BACKEND_PID=$!
cd ..

# Function to check if backend is ready
check_backend() {
    # Try multiple endpoints to ensure backend is ready
    curl -s http://127.0.0.1:8001/admin/ > /dev/null 2>&1 || \
    curl -s http://127.0.0.1:8001/api/ > /dev/null 2>&1
}

# Wait for backend to start with timeout
echo "⏳ Waiting for Django backend to start..."
COUNTER=0
MAX_WAIT=30  # Maximum 30 seconds wait

while ! check_backend; do
    if [ $COUNTER -ge $MAX_WAIT ]; then
        echo "❌ Django backend failed to start after ${MAX_WAIT} seconds"
        echo "Check the backend logs above for errors"
        kill $BACKEND_PID 2>/dev/null
        exit 1
    fi
    
    # Check if backend process is still running
    if ! ps -p $BACKEND_PID > /dev/null; then
        echo "❌ Django backend process exited unexpectedly"
        exit 1
    fi
    
    sleep 1
    COUNTER=$((COUNTER + 1))
    
    # Show progress
    if [ $((COUNTER % 5)) -eq 0 ]; then
        echo "   Still waiting... ($COUNTER seconds)"
    fi
done

echo "✅ Django backend is running on http://127.0.0.1:8001"
echo ""
echo "📝 Note: If you see errors above, the backend may still work."
echo "   The frontend will run with or without the backend."
echo ""

# Load bot configuration if it exists
if [ -f ".bot-config" ]; then
    source .bot-config
fi

# Start Discord Bot if configured and directory exists
if [ -n "$BOT_DIR" ] && [ -d "$BOT_DIR" ] && [ -f "$BOT_DIR/run_bot.sh" ]; then
    # Check if Discord bot is already running
    EXISTING_BOT=$(ps aux | grep "python discord_bot.py" | grep -v grep | head -1)
    if [ -n "$EXISTING_BOT" ]; then
        echo "⚠️  Discord Bot is already running"
        echo "   $EXISTING_BOT"
        BOT_PID=$(echo "$EXISTING_BOT" | awk '{print $2}')
    else
        echo "🤖 Starting Discord Bot..."
        cd "$BOT_DIR"
        ./run_bot.sh > /tmp/discord-bot.log 2>&1 &
        BOT_PID=$!
        cd - > /dev/null
    fi
    
    # Give bot time to start
    sleep 2
    
    if ps -p $BOT_PID > /dev/null 2>&1; then
        echo "✅ Discord Bot started (PID: $BOT_PID)"
        echo "   Discord bot should appear online shortly"
        echo "   Use: !addmsg \"command\" [terminal_number] in Discord"
    else
        echo "⚠️  Discord Bot process started but may have exited"
        echo "   Check /tmp/discord-bot.log for details"
    fi
elif [ -z "$BOT_DIR" ]; then
    echo "ℹ️  Discord Bot not configured (create .bot-config with BOT_DIR path to enable)"
else
    echo "⚠️  Discord Bot directory not found or run_bot.sh missing"
    echo "   Expected at: $BOT_DIR/run_bot.sh"
fi
echo ""

# Start Auto-Injector app
echo "🖥️  Starting Auto-Injector app..."
npm start

# Cleanup when Auto-Injector app exits
cleanup