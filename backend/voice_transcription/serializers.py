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
    # Accepted for backwards compatibility only — the view always transcribes
    # with quantized large-v3 regardless of what the caller asks for.
    model = serializers.ChoiceField(
        choices=[
            ('tiny', 'Whisper Tiny (fastest, least accurate)'),
            ('base', 'Whisper Base (balanced)'),
            ('small', 'Whisper Small (better accuracy)'),
            ('medium', 'Whisper Medium (high accuracy, slower)'),
            ('large-v3', 'Whisper Large v3 (best accuracy; int8_float16)'),
        ],
        default='large-v3'
    )
    # Default to None; the view coerces a missing language to 'en' (auto-detect
    # hallucinated other languages on short memos).
    language = serializers.CharField(
        max_length=10, required=False, allow_null=True, default=None
    )