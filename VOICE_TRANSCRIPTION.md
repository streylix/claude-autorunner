# Voice Transcription System

## Overview

The Auto-Injector now includes a **completely offline voice transcription system** powered by OpenAI Whisper running locally. This system requires no internet connection and processes all audio locally for privacy and reliability.

## Features

✅ **Completely Offline** - No internet connection required  
✅ **Free & Open Source** - Uses OpenAI Whisper (MIT license)  
✅ **High Accuracy** - Supports multiple Whisper model sizes  
✅ **Cross-Platform** - Works on Windows, macOS, and Linux  
✅ **Privacy First** - All audio processing happens locally  
✅ **Auto-Bundled** - Backend is packaged with application builds  

## How It Works

1. **Audio Capture**: Uses browser's MediaRecorder API to capture microphone audio
2. **Local Processing**: Audio is sent to local Django backend running on localhost:8001
3. **Whisper Transcription**: OpenAI Whisper processes audio completely offline
4. **Text Output**: Transcribed text is automatically inserted into message input

## Setup Instructions

### 1. First-Time Setup

Run the setup script to install dependencies and download Whisper models:

```bash
./setup_voice_backend.sh
```

This will:
- Install Python dependencies (Whisper, PyTorch, etc.)
- Create database tables for transcription history
- Download and cache the Whisper base model

### 2. Starting the Application

Always use the backend startup script:

```bash
./start_with_backend.sh
```

This automatically starts both the Django backend and Electron app.

## Usage

### Voice Recording

1. **Click the microphone button** 🎤 in the bottom-right corner
2. **Or use the hotkey**: `Cmd+Shift+V` (macOS) / `Ctrl+Shift+V` (Windows/Linux)
3. **Speak your message** - the button will show "recording" state
4. **Click again to stop** - the button will show "processing" state
5. **Wait for transcription** - text will automatically appear in the input field

### Model Selection

The system uses the **Whisper base model** by default, which provides a good balance of speed and accuracy. You can modify the model in `renderer.js` if needed:

- `tiny` - Fastest, least accurate
- `base` - Balanced (default)
- `small` - Better accuracy, slower
- `medium` - High accuracy, much slower

## Technical Architecture

### Backend Components

```
backend/voice_transcription/
├── models.py              # Database models for transcription history
├── views.py               # API endpoints for transcription
├── transcription_service.py # Whisper integration service
├── serializers.py         # API serializers
└── urls.py               # URL routing
```

### API Endpoints

- `POST /api/voice/transcribe/` - Upload audio for transcription
- `GET /api/voice/health/` - Check backend health status
- `GET /api/voice/list/` - List recent transcriptions
- `DELETE /api/voice/clear/` - Clear transcription history

### Frontend Integration

The frontend (`renderer.js`) handles:
- Microphone access and audio recording
- Backend health checking
- Audio format conversion
- UI state management
- Error handling and user feedback

## Packaging for Distribution

The voice transcription backend is designed to be bundled with Electron builds:

### Dependencies Included

- **Python runtime** (embedded with app)
- **Django backend** (lightweight HTTP server)
- **Whisper models** (cached locally)
- **PyTorch** (CPU-optimized for inference)

### Build Process

1. Backend is packaged as a standalone Python application
2. Whisper models are pre-downloaded during build
3. Django server starts automatically with main application
4. All processing remains completely local

## Troubleshooting

### Common Issues

**Backend not starting:**
```bash
cd backend
source venv/bin/activate
python manage.py runserver 127.0.0.1:8001
```

**Whisper model not found:**
```bash
python -c "import whisper; whisper.load_model('base')"
```

**Microphone permission denied:**
- Check browser/system microphone permissions
- Try refreshing the application

**Audio processing fails:**
- Ensure you're speaking clearly into the microphone
- Check that audio is being captured (browser dev tools)
- Verify backend is running on localhost:8001

### Performance Optimization

- **Use tiny model** for faster transcription on slower hardware
- **Use medium model** for better accuracy on faster hardware
- **Adjust audio quality** in MediaRecorder settings if needed

## Privacy & Security

✅ **No data leaves your machine** - All processing is local  
✅ **No cloud services** - No API keys or external dependencies  
✅ **Temporary files only** - Audio files are cleaned up immediately  
✅ **Optional history** - Transcription history can be cleared anytime  

## Future Enhancements

- [ ] Model size selection in UI
- [ ] Real-time transcription display
- [ ] Multiple language support
- [ ] Voice activity detection
- [ ] Custom vocabulary/domain adaptation