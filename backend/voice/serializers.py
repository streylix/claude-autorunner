from rest_framework import serializers
from .models import VoiceTranscription


class VoiceTranscriptionSerializer(serializers.ModelSerializer):
    class Meta:
        model = VoiceTranscription
        fields = ['id', 'terminal_session', 'audio_file', 'transcribed_text', 'created_at', 'duration', 'status', 'error_message']
        read_only_fields = ['id', 'created_at', 'transcribed_text', 'duration', 'status', 'error_message']