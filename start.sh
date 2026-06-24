#!/bin/bash

# Start both Django backend and Auto-Injector app
# This script starts the Django backend first, then the Auto-Injector app
# Usage: ./start.sh [--setup|--venv]
#   default: backend runs in Docker (docker compose up); falls back to the
#            local venv automatically when docker compose is unavailable
#   --venv:  force the local venv backend (also: VENV=1)
#   --setup: run initial setup checks and install dependencies (venv flow)

# Colors for output
RED='[0;31m'
GREEN='[0;32m'
YELLOW='[1;33m'
NC='[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Check for --setup flag
RUN_SETUP=false
if [ "$1" == "--setup" ]; then
    RUN_SETUP=true
    echo "🔧 Running setup checks..."
    echo ""
fi

# Backend mode: Docker is the DEFAULT. --venv (or VENV=1) forces the local
# venv flow; --setup implies venv; missing docker compose falls back to venv.
# (--docker is still accepted as a no-op for compatibility.)
USE_DOCKER=true
if [ "$1" == "--venv" ] || [ "$VENV" == "1" ] || [ "$RUN_SETUP" == "true" ]; then
    USE_DOCKER=false
elif ! docker compose version &> /dev/null; then
    print_warning "docker compose not available - falling back to the local venv backend"
    USE_DOCKER=false
elif ! docker info &> /dev/null; then
    print_warning "Docker daemon not running - falling back to the local venv backend (start Docker Desktop to use the default flow)"
    USE_DOCKER=false
fi

if [ "$USE_DOCKER" == "true" ]; then
    echo "🐳 Starting Django backend + Postgres via docker compose..."
    docker compose up -d --wait
    if [ $? -ne 0 ]; then
        echo "❌ docker compose failed to bring up the backend. Check 'docker compose logs'."
        exit 1
    fi
    echo "✅ Backend healthy on http://localhost:8123"

    if [ ! -d "node_modules" ]; then
        echo "⚠️  Node modules not found. Running npm install..."
        npm install || { echo "❌ npm install failed."; exit 1; }
    fi

    echo "🖥️  Starting Auto-Injector app..."
    npm start

    echo "🧹 Stopping backend containers..."
    docker compose down
    exit 0
fi

# Run setup only if --setup flag is provided
if [ "$RUN_SETUP" == "true" ]; then
    # Check if npm is installed
    if ! command -v npm &> /dev/null; then
        print_error "npm is not installed. Please install Node.js and npm first."
        echo "Visit https://nodejs.org/ to download and install Node.js"
        exit 1
    fi

    # Check if Python is installed
    if ! command -v python3 &> /dev/null && ! command -v python &> /dev/null; then
        print_error "Python is not installed. Please install Python 3.9 or later."
        echo "Visit https://www.python.org/downloads/ to download and install Python"
        exit 1
    fi

    # Determine Python command
    if command -v python3 &> /dev/null; then
        PYTHON_CMD="python3"
    else
        PYTHON_CMD="python"
    fi

    # Check Python version
    PYTHON_VERSION=$($PYTHON_CMD --version 2>&1 | awk '{print $2}')
    echo "📦 Using Python version: $PYTHON_VERSION"

    # Check if node_modules exists, if not run npm install
    if [ ! -d "node_modules" ]; then
        print_warning "Node modules not found. Running npm install..."
        npm install
        if [ $? -eq 0 ]; then
            print_status "npm install completed successfully"
        else
            print_error "npm install failed. Please check the error messages above."
            exit 1
        fi
    else
        print_status "Node modules already installed"
    fi

    # Check backend setup
    echo ""
    echo "🔧 Checking backend setup..."

    # Check if backend directory exists
    if [ ! -d "backend" ]; then
        print_error "Backend directory not found!"
        exit 1
    fi

    cd backend

    # Check if virtual environment exists
    if [ ! -d "venv" ]; then
        print_warning "Python virtual environment not found. Creating venv..."
        $PYTHON_CMD -m venv venv
        if [ $? -eq 0 ]; then
            print_status "Virtual environment created"
        else
            print_error "Failed to create virtual environment"
            echo "Try running: $PYTHON_CMD -m pip install --user virtualenv"
            exit 1
        fi
    fi

    # Activate virtual environment
    echo "🐍 Activating Python virtual environment..."
    source venv/bin/activate

    # Check if pip needs upgrading
    pip install --upgrade pip --quiet 2>/dev/null

    # Check if Django is installed
    if ! python -c "import django" 2>/dev/null; then
        print_warning "Django not found. Installing backend requirements..."
        pip install -r requirements.txt
        if [ $? -eq 0 ]; then
            print_status "Backend requirements installed successfully"
        else
            print_error "Failed to install backend requirements"
            echo "You may need to install dependencies manually:"
            echo "  cd backend"
            echo "  source venv/bin/activate"
            echo "  pip install -r requirements.txt"
            exit 1
        fi
    else
        # Check if all requirements are satisfied
        echo "📋 Checking backend requirements..."
        pip install -q -r requirements.txt 2>/dev/null
        print_status "Backend requirements verified"
    fi

    # Kokoro text-to-speech (spoken notifications) needs the espeak-ng binary.
    # The Docker image installs it automatically; the venv flow does not.
    if ! command -v espeak-ng >/dev/null 2>&1; then
        print_warning "espeak-ng not found — spoken notifications (Kokoro TTS) will fail. Install it: brew install espeak-ng (macOS) / apt-get install espeak-ng (Linux)."
    fi

    # Run migrations if needed
    echo "🗄️  Checking database migrations..."
    python manage.py migrate --noinput 2>/dev/null
    if [ $? -eq 0 ]; then
        print_status "Database migrations completed"
    else
        print_warning "Database migrations may need attention"
    fi

    # Return to root directory
    cd ..

    echo ""
    print_status "Setup completed successfully!"
    echo ""
fi

# Quick startup checks (always run)
if [ ! -d "node_modules" ]; then
    print_error "Node modules not found. Please run: ./start.sh --setup"
    exit 1
fi

if [ ! -d "backend/venv" ]; then
    print_error "Python virtual environment not found. Please run: ./start.sh --setup"
    exit 1
fi

# Vosk wake-word model is gitignored (~39 MB); fetch it if missing.
if [ ! -f "assets/models/vosk-model-small-en-us.tar.gz" ]; then
    echo "🎤 Vosk wake-word model missing — downloading..."
    npm run download-models
fi

echo "🚀 Starting Terminal GUI with Django Backend..."
echo ""

# Colors for output
RED='[0;31m'
GREEN='[0;32m'
YELLOW='[1;33m'
NC='[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    print_error "npm is not installed. Please install Node.js and npm first."
    echo "Visit https://nodejs.org/ to download and install Node.js"
    exit 1
fi

# Check if Python is installed
if ! command -v python3 &> /dev/null && ! command -v python &> /dev/null; then
    print_error "Python is not installed. Please install Python 3.9 or later."
    echo "Visit https://www.python.org/downloads/ to download and install Python"
    exit 1
fi

# Determine Python command
if command -v python3 &> /dev/null; then
    PYTHON_CMD="python3"
else
    PYTHON_CMD="python"
fi

# Check Python version
PYTHON_VERSION=$($PYTHON_CMD --version 2>&1 | awk '{print $2}')
echo "📦 Using Python version: $PYTHON_VERSION"

# Check if node_modules exists, if not run npm install
if [ ! -d "node_modules" ]; then
    print_warning "Node modules not found. Running npm install..."
    npm install
    if [ $? -eq 0 ]; then
        print_status "npm install completed successfully"
    else
        print_error "npm install failed. Please check the error messages above."
        exit 1
    fi
else
    print_status "Node modules already installed"
fi

# Check backend setup
echo ""
echo "🔧 Checking backend setup..."

# Check if backend directory exists
if [ ! -d "backend" ]; then
    print_error "Backend directory not found!"
    exit 1
fi

cd backend

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    print_warning "Python virtual environment not found. Creating venv..."
    $PYTHON_CMD -m venv venv
    if [ $? -eq 0 ]; then
        print_status "Virtual environment created"
    else
        print_error "Failed to create virtual environment"
        echo "Try running: $PYTHON_CMD -m pip install --user virtualenv"
        exit 1
    fi
fi

# Activate virtual environment
echo "🐍 Activating Python virtual environment..."
source venv/bin/activate

# Check if pip needs upgrading
pip install --upgrade pip --quiet 2>/dev/null

# Check if Django is installed
if ! python -c "import django" 2>/dev/null; then
    print_warning "Django not found. Installing backend requirements..."
    pip install -r requirements.txt
    if [ $? -eq 0 ]; then
        print_status "Backend requirements installed successfully"
    else
        print_error "Failed to install backend requirements"
        echo "You may need to install dependencies manually:"
        echo "  cd backend"
        echo "  source venv/bin/activate"
        echo "  pip install -r requirements.txt"
        exit 1
    fi
else
    # Check if all requirements are satisfied
    echo "📋 Checking backend requirements..."
    pip install -q -r requirements.txt 2>/dev/null
    print_status "Backend requirements verified"
fi

# Kokoro text-to-speech (spoken notifications) needs the espeak-ng binary.
# The Docker image installs it automatically; the venv flow does not.
if ! command -v espeak-ng >/dev/null 2>&1; then
    print_warning "espeak-ng not found — spoken notifications (Kokoro TTS) will fail. Install it: brew install espeak-ng (macOS) / apt-get install espeak-ng (Linux)."
fi

# Check if .env file exists
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
    print_warning ".env file not found. Creating from .env.example..."
    cp .env.example .env
    print_status ".env file created. You may need to update it with your settings."
fi

# Run migrations if needed
echo "🗄️  Checking database migrations..."
python manage.py migrate --noinput 2>/dev/null
if [ $? -eq 0 ]; then
    print_status "Database migrations completed"
else
    print_warning "Database migrations may need attention"
fi

# Return to root directory
cd ..

echo ""
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
echo "📡 Starting Django backend on port 8123..."
cd backend
source venv/bin/activate
python manage.py runserver 127.0.0.1:8123 --noreload &
BACKEND_PID=$!
cd ..

# Function to check if backend is ready
check_backend() {
    # Try multiple endpoints to ensure backend is ready
    curl -s http://127.0.0.1:8123/admin/ > /dev/null 2>&1 || \
    curl -s http://127.0.0.1:8123/api/ > /dev/null 2>&1
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

echo "✅ Django backend is running on http://127.0.0.1:8123"
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