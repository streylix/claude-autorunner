from rest_framework import status
from rest_framework.decorators import api_view, parser_classes
from rest_framework.parsers import MultiPartParser, FileUploadParser
from rest_framework.response import Response
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.utils.decorators import method_decorator
from django.views import View
import json
import logging
import traceback

from .transcription_service import transcription_service
from .serializers import AudioUploadSerializer, VoiceTranscriptionSerializer
from .models import VoiceTranscription

logger = logging.getLogger(__name__)


@api_view(['POST'])
@parser_classes([MultiPartParser, FileUploadParser])
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