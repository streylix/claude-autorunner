# Backend Troubleshooting Guide

## Common Startup Issues

### 1. Port Already in Use
**Error**: `[Errno 48] Address already in use`

**Solution**:
```bash
# Kill any process using port 8001
lsof -ti:8001 | xargs kill -9

# Or use a different port
python manage.py runserver 127.0.0.1:8002
```

### 2. Virtual Environment Issues
**Error**: `command not found: python` or module import errors

**Solution**:
```bash
cd backend
source venv/bin/activate  # Make sure you're in the virtual environment
pip install -r requirements.txt  # Reinstall dependencies if needed
```

### 3. Database Migration Issues
**Error**: `no such table` or migration errors

**Solution**:
```bash
cd backend
source venv/bin/activate
python manage.py makemigrations
python manage.py migrate
```

### 4. Missing OpenAI API Key
**Error**: `OpenAI API key is not configured`

**Solution**:
```bash
cd backend
cp .env.example .env
# Edit .env and add your OpenAI API key:
# OPENAI_API_KEY=your_api_key_here
```

## Startup Options

### Option 1: Quick Start (Recommended)
```bash
./start_simple.sh
```
- Starts frontend immediately
- Backend runs in background
- Check `backend/backend.log` for backend status

### Option 2: Wait for Backend
```bash
./start_with_backend.sh
```
- Waits for backend to be ready
- May timeout if backend has issues
- More reliable for development

### Option 3: Manual Start
```bash
# Terminal 1 - Backend
cd backend
source venv/bin/activate
python manage.py runserver 127.0.0.1:8001

# Terminal 2 - Frontend
npm start
```

## Testing Backend

### Check if Backend is Running
```bash
curl http://127.0.0.1:8001/admin/
```

### Test API Endpoints
```bash
# Test terminal sessions
curl http://127.0.0.1:8001/api/terminal/sessions/

# Test todos (requires OpenAI key)
curl http://127.0.0.1:8001/api/todos/items/
```

### Run Backend Tests
```bash
cd backend
source venv/bin/activate
python test_backend.py
```

## Frontend Works Without Backend

The Electron app is designed to work with or without the Django backend:

- **With Backend**: Full features including AI todo generation, persistent storage
- **Without Backend**: Basic functionality, local storage only

## Log Files

- **Backend logs**: `backend/backend.log` (when using start_simple.sh)
- **Frontend logs**: Check the Electron app's developer console (Cmd+Option+I)

## Getting Help

1. Check the logs first
2. Ensure all dependencies are installed
3. Verify your .env configuration
4. Try manual startup to isolate issues