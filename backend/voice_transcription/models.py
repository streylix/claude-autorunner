from django.db import models
import uuid


class VoiceTranscription(models.Model):
    """Model to store voice transcription results"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    audio_filename = models.CharField(max_length=255)
    transcription_text = models.TextField()
    confidence_score = models.FloatField(null=True, blank=True)
    model_used = models.CharField(max_length=100, default='whisper-base')
    processing_time = models.FloatField(help_text="Processing time in seconds")
    created_at = models.DateTimeField(auto_now_add=True)
    
    class Meta:
        ordering = ['-created_at']
        
    def __str__(self):
        return f"Transcription {self.id} - {self.transcription_text[:50]}..."