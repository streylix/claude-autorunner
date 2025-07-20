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
    language = serializers.CharField(max_length=10, default='en', required=False)