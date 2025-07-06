from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.parsers import MultiPartParser, FormParser
from .models import VoiceTranscription
from .serializers import VoiceTranscriptionSerializer
from .services import VoiceTranscriptionService
from message_queue.models import MessageHistory
import os
from pydub import AudioSegment


class VoiceTranscriptionViewSet(viewsets.ModelViewSet):
    queryset = VoiceTranscription.objects.all()
    serializer_class = VoiceTranscriptionSerializer
    parser_classes = (MultiPartParser, FormParser)
    
    def create(self, request, *args, **kwargs):
        # Handle file upload and create transcription record
        terminal_session_id = request.data.get('terminal_session')
        audio_file = request.FILES.get('audio_file')
        
        if not audio_file:
            return Response({'error': 'No audio file provided'}, status=status.HTTP_400_BAD_REQUEST)
        
        # Create transcription record
        transcription = VoiceTranscription.objects.create(
            terminal_session_id=terminal_session_id,
            audio_file=audio_file,
            status='processing'
        )
        
        # Process transcription asynchronously (in production, use Celery)
        self._process_transcription(transcription)
        
        serializer = self.get_serializer(transcription)
        return Response(serializer.data, status=status.HTTP_201_CREATED)
    
    def _process_transcription(self, transcription):
        """Process the transcription (in production, this would be a Celery task)"""
        try:
            # Get audio duration
            audio = AudioSegment.from_file(transcription.audio_file.path)
            transcription.duration = len(audio) / 1000.0  # Convert to seconds
            
            # Perform transcription
            service = VoiceTranscriptionService()
            result = service.transcribe_audio_file(transcription.audio_file.path)
            
            if result['success']:
                transcription.transcribed_text = result['text']
                transcription.status = 'completed'
                
                # Add to message history
                MessageHistory.objects.create(
                    terminal_session=transcription.terminal_session,
                    message=result['text'],
                    source='voice'
                )
            else:
                transcription.status = 'failed'
                transcription.error_message = result['error']
            
            transcription.save()
            
        except Exception as e:
            transcription.status = 'failed'
            transcription.error_message = str(e)
            transcription.save()
    
    @action(detail=True, methods=['get'])
    def status(self, request, pk=None):
        """Check transcription status"""
        transcription = self.get_object()
        serializer = self.get_serializer(transcription)
        return Response(serializer.data)
    
    @action(detail=False, methods=['post'])
    def transcribe_base64(self, request):
        """Alternative endpoint for base64 encoded audio"""
        import base64
        import tempfile
        
        terminal_session_id = request.data.get('terminal_session')
        audio_base64 = request.data.get('audio_data')
        file_format = request.data.get('format', 'webm')
        
        if not audio_base64:
            return Response({'error': 'No audio data provided'}, status=status.HTTP_400_BAD_REQUEST)
        
        try:
            # Decode base64 audio
            audio_data = base64.b64decode(audio_base64)
            
            # Save to temporary file
            with tempfile.NamedTemporaryFile(suffix=f'.{file_format}', delete=False) as tmp_file:
                tmp_file.write(audio_data)
                tmp_file_path = tmp_file.name
            
            # Create transcription record
            transcription = VoiceTranscription.objects.create(
                terminal_session_id=terminal_session_id,
                status='processing'
            )
            
            # Move temp file to media directory
            from django.core.files import File
            with open(tmp_file_path, 'rb') as f:
                transcription.audio_file.save(f'voice_{transcription.id}.{file_format}', File(f))
            
            # Process transcription
            self._process_transcription(transcription)
            
            # Clean up temp file
            os.remove(tmp_file_path)
            
            serializer = self.get_serializer(transcription)
            return Response(serializer.data, status=status.HTTP_201_CREATED)
            
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)
