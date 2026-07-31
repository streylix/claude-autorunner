from rest_framework import status
from rest_framework.decorators import api_view, parser_classes, throttle_classes
from rest_framework.parsers import MultiPartParser, FileUploadParser
from rest_framework.response import Response

from terminal_backend.api_security import VoiceTranscribeThrottle
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.utils.decorators import method_decorator
from django.views import View
import json
import logging
import threading
import time
import traceback

from .transcription_service import transcription_service
from .serializers import AudioUploadSerializer, VoiceTranscriptionSerializer
from .models import VoiceTranscription

logger = logging.getLogger(__name__)

# Reject audio uploads larger than this to avoid OOM / abuse.
MAX_AUDIO_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB

# Discord-bridge presence (in-memory, single ASGI process — no DB/migration,
# mirrors wake_service's module-level singleton). The bridge heartbeats its
# "active" (linked + in a voice channel) state here; the desktop app polls it to
# mute the local wake word. A report older than the TTL counts as inactive, so a
# crashed/closed bridge can never leave the app's wake word stuck muted.
_bridge_status_lock = threading.Lock()
_bridge_status = {'active': False, 'last_seen': 0.0}
BRIDGE_STATUS_TTL_SECONDS = 8.0  # bridge heartbeats every ~2.5s
# Keep only the newest N transcription rows to bound unbounded table growth.
MAX_TRANSCRIPTION_ROWS = 500


def _prune_transcriptions():
    """Delete transcription rows beyond the newest MAX_TRANSCRIPTION_ROWS.

    The model orders by -created_at, so the kept set is the first N pks. Any row
    not in that set is deleted. Best-effort: failures here must not break the
    transcription response.
    """
    try:
        keep_ids = list(
            VoiceTranscription.objects.values_list('id', flat=True)[:MAX_TRANSCRIPTION_ROWS]
        )
        deleted, _ = VoiceTranscription.objects.exclude(id__in=keep_ids).delete()
        if deleted:
            logger.info(f"Pruned {deleted} old transcription rows (cap={MAX_TRANSCRIPTION_ROWS})")
    except Exception as e:
        logger.warning(f"Failed to prune transcriptions: {e}")


@api_view(['POST'])
@parser_classes([MultiPartParser, FileUploadParser])
@throttle_classes([VoiceTranscribeThrottle])
def transcribe_audio(request):
    """
    Transcribe uploaded audio file
    """
    try:
        serializer = AudioUploadSerializer(data=request.data)
        if not serializer.is_valid():
            return Response({
                'success': False,
                'error': 'Invalid input data',
                'details': serializer.errors
            }, status=status.HTTP_400_BAD_REQUEST)

        audio_file = serializer.validated_data['audio_file']
        model_name = serializer.validated_data.get('model', 'base')
        language = serializer.validated_data.get('language')

        # Reject oversized uploads before reading them into memory.
        if audio_file.size is not None and audio_file.size > MAX_AUDIO_UPLOAD_BYTES:
            return Response({
                'success': False,
                'error': (
                    f'Audio file too large ({audio_file.size} bytes). '
                    f'Maximum allowed is {MAX_AUDIO_UPLOAD_BYTES} bytes (50 MB).'
                )
            }, status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)
        
        # Save uploaded file temporarily
        temp_file_path = None
        try:
            # Read audio data
            audio_data = audio_file.read()
            
            # Save to temporary file
            temp_file_path = transcription_service.save_temp_audio_file(
                audio_data, 
                suffix=f'.{audio_file.name.split(".")[-1]}'
            )
            
            # Transcribe
            result = transcription_service.transcribe_audio(
                temp_file_path, 
                model_name=model_name,
                language=language
            )
            
            if result['success']:
                # Save to database
                transcription = VoiceTranscription.objects.create(
                    audio_filename=audio_file.name,
                    transcription_text=result['text'],
                    confidence_score=result.get('confidence', 0.0),
                    model_used=result['model_used'],
                    processing_time=result['processing_time']
                )

                # Cap table growth: keep only the newest MAX_TRANSCRIPTION_ROWS.
                _prune_transcriptions()

                response_data = {
                    'success': True,
                    'transcription_id': str(transcription.id),
                    'text': result['text'],
                    'confidence': result.get('confidence', 0.0),
                    'language': result.get('language', 'unknown'),
                    'model_used': result['model_used'],
                    'processing_time': result['processing_time']
                }
                
                logger.info(f"Successful transcription: {result['text'][:100]}...")
                return Response(response_data, status=status.HTTP_200_OK)
            else:
                return Response({
                    'success': False,
                    'error': result.get('error', 'Transcription failed'),
                    'processing_time': result['processing_time']
                }, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
                
        finally:
            # Cleanup temporary file
            if temp_file_path:
                transcription_service.cleanup_temp_file(temp_file_path)
                
    except Exception as e:
        logger.error(f"Transcription endpoint error: {e}")
        logger.error(traceback.format_exc())
        return Response({
            'success': False,
            'error': f'Server error: {str(e)}'
        }, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(['POST'])
@parser_classes([MultiPartParser, FileUploadParser])
@throttle_classes([VoiceTranscribeThrottle])
def wake_check(request):
    """
    Cheap CPU wake-word transcription (Vosk). Returns Vosk's best-effort text so
    a caller can gate on a wake word WITHOUT running the GPU Whisper model on
    every utterance. Same multipart contract as /transcribe/ (field audio_file).

    Response: { "success": true, "text": "<vosk transcript>" }

    The caller decides whether the wake word is present (the desktop app / bridge
    own the phrase + matching). This endpoint just provides a fast, GPU-free
    transcript for gating.
    """
    from .wake_service import wake_service

    audio_file = request.FILES.get('audio_file')
    if audio_file is None:
        return Response({'success': False, 'error': 'audio_file is required'},
                        status=status.HTTP_400_BAD_REQUEST)
    if audio_file.size is not None and audio_file.size > MAX_AUDIO_UPLOAD_BYTES:
        return Response({'success': False, 'error': 'Audio file too large'},
                        status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)

    temp_file_path = None
    try:
        data = audio_file.read()
        temp_file_path = transcription_service.save_temp_audio_file(data, '.wav')
        text = wake_service.transcribe(temp_file_path)
        return Response({'success': True, 'text': text}, status=status.HTTP_200_OK)
    except Exception as e:
        logger.error(f"Wake-check endpoint error: {e}")
        logger.error(traceback.format_exc())
        return Response({'success': False, 'error': f'Server error: {str(e)}'},
                        status=status.HTTP_500_INTERNAL_SERVER_ERROR)
    finally:
        if temp_file_path:
            transcription_service.cleanup_temp_file(temp_file_path)


@api_view(['GET', 'POST'])
def bridge_status(request):
    """Discord-bridge presence, used by the desktop app to mute its local wake word.

    POST { "active": bool }  - the bridge heartbeats whether it is in a voice channel.
    GET  -> { "active": bool, "age_seconds": float|None } - active is True only if the
    bridge reported within BRIDGE_STATUS_TTL_SECONDS, so the app never stays muted
    after the bridge goes away.
    """
    now = time.monotonic()

    if request.method == 'POST':
        active = bool(request.data.get('active'))
        with _bridge_status_lock:
            _bridge_status['active'] = active
            _bridge_status['last_seen'] = now
        return Response({'success': True, 'active': active}, status=status.HTTP_200_OK)

    with _bridge_status_lock:
        reported = _bridge_status['active']
        last_seen = _bridge_status['last_seen']
    age = (now - last_seen) if last_seen else None
    fresh = age is not None and age < BRIDGE_STATUS_TTL_SECONDS
    return Response(
        {'success': True, 'active': bool(reported and fresh), 'age_seconds': age},
        status=status.HTTP_200_OK,
    )


@api_view(['GET'])
def health_check(request):
    """
    Health check endpoint for voice transcription service
    """
    try:
        # Test if Whisper can be loaded
        test_model = transcription_service._get_model('base')
        
        return Response({
            'success': True,
            'status': 'Voice transcription service is running',
            'available_models': ['tiny', 'base', 'small', 'medium'],
            'device': transcription_service.device,
            'whisper_loaded': test_model is not None
        }, status=status.HTTP_200_OK)
        
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return Response({
            'success': False,
            'status': 'Voice transcription service error',
            'error': str(e)
        }, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(['GET'])
def list_transcriptions(request):
    """
    List recent transcriptions
    """
    try:
        transcriptions = VoiceTranscription.objects.all()[:20]  # Last 20
        serializer = VoiceTranscriptionSerializer(transcriptions, many=True)
        return Response({
            'success': True,
            'transcriptions': serializer.data
        }, status=status.HTTP_200_OK)
        
    except Exception as e:
        logger.error(f"List transcriptions error: {e}")
        return Response({
            'success': False,
            'error': str(e)
        }, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(['DELETE'])
def clear_transcriptions(request):
    """
    Clear all transcription history
    """
    try:
        count = VoiceTranscription.objects.all().count()
        VoiceTranscription.objects.all().delete()
        
        return Response({
            'success': True,
            'message': f'Cleared {count} transcriptions'
        }, status=status.HTTP_200_OK)
        
    except Exception as e:
        logger.error(f"Clear transcriptions error: {e}")
        return Response({
            'success': False,
            'error': str(e)
        }, status=status.HTTP_500_INTERNAL_SERVER_ERROR)