from django.db import models
from terminal.models import TerminalSession
import uuid


class VoiceTranscription(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    terminal_session = models.ForeignKey(TerminalSession, on_delete=models.CASCADE, related_name='voice_transcriptions')
    audio_file = models.FileField(upload_to='voice_recordings/')
    transcribed_text = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    duration = models.FloatField(null=True, blank=True)  # Duration in seconds
    status = models.CharField(max_length=20, choices=[
        ('pending', 'Pending'),
        ('processing', 'Processing'),
        ('completed', 'Completed'),
        ('failed', 'Failed'),
    ], default='pending')
    error_message = models.TextField(blank=True)
    
    class Meta:
        ordering = ['-created_at']
    
    def __str__(self):
        return f"Transcription {self.id} - {self.status}"
