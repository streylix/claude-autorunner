#!/bin/bash

# Simple startup script that starts the app immediately
# Backend startup happens in background without blocking

echo "🚀 Starting Terminal GUI..."

# Check if backend directory exists
if [ -d "backend" ]; then
    echo "📡 Starting Django backend in background..."
    cd backend
    if [ -d "venv" ]; then
        source venv/bin/activate
        nohup python manage.py runserver 127.0.0.1:8001 > backend.log 2>&1 &
        echo "   Backend logs: backend/backend.log"
    else
        echo "   ⚠️  Backend virtual environment not found"
    fi
    cd ..
else
    echo "   ⚠️  Backend directory not found"
fi

echo ""
echo "🖥️  Starting Auto-Injector app..."
echo "   The app will work with or without the backend"
echo ""

# Start Auto-Injector app
npm start