#!/bin/bash

# Setup script for voice transcription backend
echo "🎤 Setting up Voice Transcription Backend..."

# Check if backend directory exists
if [ ! -d "backend" ]; then
    echo "❌ Backend directory not found!"
    exit 1
fi

cd backend

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "📦 Creating Python virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment
echo "🔧 Activating virtual environment..."
source venv/bin/activate

# Install/upgrade dependencies
echo "📥 Installing Python dependencies..."
pip install --upgrade pip
pip install -r requirements.txt

# Create database migrations for voice transcription
echo "🗃️ Creating database migrations..."
python manage.py makemigrations voice_transcription

# Run migrations
echo "🚀 Running database migrations..."
python manage.py migrate

# Download Whisper base model (this will cache it locally)
echo "📥 Downloading Whisper base model (this may take a few minutes)..."
python -c "
import whisper
import torch

print('Device:', 'cuda' if torch.cuda.is_available() else 'cpu')
print('Loading Whisper base model...')
model = whisper.load_model('base')
print('✅ Whisper base model downloaded and cached successfully!')
"

echo ""
echo "✅ Voice transcription backend setup complete!"
echo ""
echo "📋 Next steps:"
echo "   1. Run: ./start_with_backend.sh"
echo "   2. Test voice transcription with Cmd+Shift+V"
echo ""
echo "📊 Backend features:"
echo "   • Offline voice transcription with OpenAI Whisper"
echo "   • No internet connection required"
echo "   • Multiple model sizes (tiny, base, small, medium)"
echo "   • Automatic audio format handling"
echo ""