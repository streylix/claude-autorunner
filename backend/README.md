# Terminal Backend - Django API Server

A Django-based backend server running on port 8001 that provides persistent storage and advanced functionality for the Auto-Injector application.

## Features

- **Terminal Session Management** - Create, manage, and track terminal sessions
- **Message Queue System** - Persistent FIFO queue for command injection
- **Voice Transcription** - Audio file processing and speech-to-text conversion
- **Settings Storage** - Persistent application configuration
- **WebSocket Support** - Real-time communication via Django Channels
- **REST API** - Comprehensive RESTful endpoints for all functionality

## Quick Start

### 1. Setup and Installation

```bash
# Navigate to backend directory
cd backend

# Create virtual environment (if not already created)
python3 -m venv venv

# Activate virtual environment
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run database migrations
python manage.py migrate

# Start the server on port 8001
./start_backend.sh
# OR manually:
python manage.py runserver 127.0.0.1:8001
```

### 2. Test the API

```bash
# Run API tests
python test_backend.py
```

### 3. Access the API

- **Base URL**: `http://127.0.0.1:8001/api/`
- **Admin Panel**: `http://127.0.0.1:8001/admin/`

## API Endpoints

### Terminal Sessions (`/api/terminal/`)

**List/Create Terminal Sessions**
- `GET /api/terminal/sessions/` - List all terminal sessions
- `POST /api/terminal/sessions/` - Create new terminal session

**Session Management**
- `GET /api/terminal/sessions/{id}/` - Get session details
- `PUT /api/terminal/sessions/{id}/` - Update session
- `DELETE /api/terminal/sessions/{id}/` - Delete session
- `POST /api/terminal/sessions/{id}/execute_command/` - Execute command in session
- `GET /api/terminal/sessions/{id}/history/` - Get command history

**Commands**
- `GET /api/terminal/commands/` - List all commands
- `POST /api/terminal/commands/` - Create command record

### Message Queue (`/api/queue/`)

**Queue Management**
- `GET /api/queue/queue/` - List queued messages
- `POST /api/queue/queue/` - Add message to queue
- `POST /api/queue/queue/{id}/inject/` - Inject specific message
- `POST /api/queue/queue/clear_queue/` - Clear pending messages

**Message History**
- `GET /api/queue/history/` - List message history
- `POST /api/queue/history/` - Add to history

### Voice Transcription (`/api/voice/`)

**Transcription Services**
- `GET /api/voice/transcriptions/` - List transcriptions
- `POST /api/voice/transcriptions/` - Upload audio file for transcription
- `POST /api/voice/transcriptions/transcribe_base64/` - Transcribe base64 audio
- `GET /api/voice/transcriptions/{id}/status/` - Check transcription status

### Settings (`/api/settings/`)

**Application Settings**
- `GET /api/settings/app-settings/` - List all settings
- `POST /api/settings/app-settings/` - Create setting
- `GET /api/settings/app-settings/{key}/` - Get setting by key
- `PUT /api/settings/app-settings/{key}/` - Update setting
- `DELETE /api/settings/app-settings/{key}/` - Delete setting

### Todo System (`/api/todos/`)

**Todo Items**
- `GET /api/todos/items/` - List todo items (filter by terminal_session, completed, auto_generated)
- `POST /api/todos/items/` - Create new todo item
- `GET /api/todos/items/{id}/` - Get specific todo item
- `PUT /api/todos/items/{id}/` - Update todo item
- `DELETE /api/todos/items/{id}/` - Delete todo item
- `POST /api/todos/items/{id}/toggle_completed/` - Toggle completion status
- `POST /api/todos/items/clear_completed/` - Clear all completed todos for a session
- `POST /api/todos/items/generate_from_output/` - Generate todos from terminal output using GPT-4o-mini

**Todo Generations**
- `GET /api/todos/generations/` - List todo generation attempts
- `GET /api/todos/generations/{id}/` - Get specific generation details

## WebSocket Endpoints

### Terminal WebSocket

**URL**: `ws://127.0.0.1:8001/ws/terminal/{session_id}/`

**Message Types**:
```javascript
// Send terminal input
{
    "type": "terminal_input",
    "data": "ls -la"
}

// Handle terminal resize
{
    "type": "resize",
    "cols": 80,
    "rows": 24
}
```

## Data Models

### Terminal Session
```json
{
    "id": "uuid",
    "name": "string",
    "created_at": "datetime",
    "updated_at": "datetime", 
    "is_active": "boolean",
    "current_directory": "string"
}
```

### Queued Message
```json
{
    "id": "uuid",
    "terminal_session": "uuid",
    "content": "string",
    "created_at": "datetime",
    "scheduled_for": "datetime",
    "injected_at": "datetime",
    "status": "pending|injected|cancelled"
}
```

### Voice Transcription
```json
{
    "id": "uuid",
    "terminal_session": "uuid",
    "audio_file": "file_url",
    "transcribed_text": "string",
    "created_at": "datetime",
    "duration": "float",
    "status": "pending|processing|completed|failed",
    "error_message": "string"
}
```

### Application Settings
```json
{
    "id": "uuid",
    "key": "string",
    "value": "json",
    "created_at": "datetime",
    "updated_at": "datetime"
}
```

### Todo Item
```json
{
    "id": "uuid",
    "terminal_session": "uuid",
    "title": "string",
    "description": "string",
    "completed": "boolean",
    "created_at": "datetime",
    "completed_at": "datetime",
    "priority": "low|medium|high",
    "source_output": "string",
    "auto_generated": "boolean"
}
```

### Todo Generation
```json
{
    "id": "uuid",
    "terminal_session": "uuid",
    "terminal_output": "string",
    "generated_at": "datetime",
    "status": "pending|processing|completed|failed",
    "error_message": "string",
    "todos_count": "integer"
}
```

## AI-Powered Todo Generation

The backend includes an intelligent todo generation system powered by OpenAI's GPT-4o-mini:

### How It Works

1. **Automatic Detection** - Monitors terminals for completion (when '...' state ends after 4+ seconds)
2. **Content Extraction** - Extracts the last 1000 characters before the '╭' prompt indicator
3. **AI Analysis** - Sends terminal output to GPT-4o-mini for analysis
4. **Todo Creation** - Generates actionable todo items based on the development work shown

### Features

- **Smart Filtering** - Only processes relevant development output
- **Contextual Todos** - Creates todos specific to testing, reviewing, and next steps
- **Priority Assignment** - Automatically assigns priority levels (low/medium/high)
- **Terminal Association** - Todo checkboxes are colored by originating terminal
- **Manual Generation** - Users can manually trigger todo generation
- **Completion Tracking** - Track and clear completed todos

### Setup

1. **Get OpenAI API Key** - Sign up at [OpenAI](https://platform.openai.com/)
2. **Create .env file** - Copy `.env.example` to `.env` in backend directory
3. **Add API Key** - Set `OPENAI_API_KEY=your_key_here` in `.env`
4. **Restart Backend** - Restart Django server to load the API key

### Example Todo Generation

**Terminal Output:**
```
Created new React component LoginForm.jsx with validation
Added authentication middleware to Express server
Updated database schema with user table
```

**Generated Todos:**
- ✅ Test LoginForm component with valid/invalid credentials (High)
- ✅ Verify authentication middleware blocks unauthorized requests (High)  
- ✅ Test database user creation and login flow (Medium)
- ✅ Review error handling in authentication flow (Medium)

## Integration with Auto-Injector App

The backend is designed to work seamlessly with the Auto-Injector application:

1. **Session Persistence** - Terminal sessions survive app restarts
2. **Queue Synchronization** - Message queue persists between sessions
3. **Voice Processing** - Centralized voice transcription handling
4. **Settings Sync** - Application settings stored persistently
5. **Todo Management** - AI-powered todo generation and tracking

### Example Integration

```javascript
// Create terminal session
const response = await fetch('http://127.0.0.1:8001/api/terminal/sessions/', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
        name: 'Main Terminal',
        current_directory: process.cwd()
    })
});

const session = await response.json();

// Add message to queue
await fetch('http://127.0.0.1:8001/api/queue/queue/', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
        terminal_session: session.id,
        content: 'echo "Hello from backend!"'
    })
});

// Connect to WebSocket
const ws = new WebSocket(`ws://127.0.0.1:8001/ws/terminal/${session.id}/`);
```

## Development

### Adding New Features

1. Create new Django app: `python manage.py startapp myapp`
2. Add to `INSTALLED_APPS` in `settings.py`
3. Create models, serializers, views, and URLs
4. Run migrations: `python manage.py makemigrations && python manage.py migrate`

### Database Management

```bash
# Create migrations
python manage.py makemigrations

# Apply migrations  
python manage.py migrate

# Create superuser
python manage.py createsuperuser

# Django shell
python manage.py shell
```

## Production Deployment

For production deployment:

1. Set `DEBUG = False` in settings.py
2. Configure proper database (PostgreSQL recommended)
3. Set up Redis for Channels
4. Use a proper ASGI server like Daphne or Uvicorn
5. Configure static/media file serving
6. Set up proper CORS and security settings

## Dependencies

- Django 4.2.7 - Web framework
- Django REST Framework 3.14.0 - API framework
- Django Channels 4.0.0 - WebSocket support
- django-cors-headers 4.3.0 - CORS handling
- SpeechRecognition 3.10.0 - Voice transcription
- pydub 0.25.1 - Audio processing
- channels-redis 4.1.0 - Redis backend for Channels

## Troubleshooting

**Port 8001 already in use:**
```bash
lsof -ti:8001 | xargs kill -9
```

**Redis connection issues:**
```bash
# Install and start Redis
brew install redis
brew services start redis
```

**Audio transcription not working:**
- Install additional audio codecs: `brew install ffmpeg`
- Check microphone permissions

## License

This backend server is part of the Terminal GUI project.