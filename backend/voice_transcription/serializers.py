from rest_framework import serializers
from .models import VoiceTranscription


class VoiceTranscriptionSerializer(serializers.ModelSerializer):
    class Meta:
        model = VoiceTranscription
        fields = ['id', 'transcription_text', 'confidence_score', 'model_used', 
                 'processing_time', 'created_at']
        read_only_fields = ['id', 'created_at']


class AudioUploadSerializer(serializers.Serializer):
    """Serializer for audio file upload"""
    audio_file = serializers.FileField()
    model = serializers.ChoiceField(
        choices=[
            ('tiny', 'Whisper Tiny (fastest, least accurate)'),
            ('base', 'Whisper Base (balanced)'),
            ('small', 'Whisper Small (better accuracy)'),
            ('medium', 'Whisper Medium (high accuracy, slower)'),
        ],
        default='base'
    )
    # Default to None so Whisper auto-detects the language. A specific code
    # (e.g. 'en') is only used when the caller explicitly passes one.
    language = serializers.CharField(
        max_length=10, required=False, allow_null=True, default=None
    )