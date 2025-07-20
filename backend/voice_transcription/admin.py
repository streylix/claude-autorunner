from django.contrib import admin
from .models import VoiceTranscription


@admin.register(VoiceTranscription)
class VoiceTranscriptionAdmin(admin.ModelAdmin):
    list_display = ['id', 'transcription_preview', 'model_used', 'confidence_score', 
                   'processing_time', 'created_at']
    list_filter = ['model_used', 'created_at']
    search_fields = ['transcription_text']
    readonly_fields = ['id', 'created_at', 'processing_time']
    ordering = ['-created_at']
    
    def transcription_preview(self, obj):
        """Show first 100 characters of transcription"""
        return obj.transcription_text[:100] + "..." if len(obj.transcription_text) > 100 else obj.transcription_text
    transcription_preview.short_description = 'Transcription Preview'