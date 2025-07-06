from django.db import models
from terminal.models import TerminalSession
import uuid


class QueuedMessage(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    terminal_session = models.ForeignKey(TerminalSession, on_delete=models.CASCADE, related_name='queued_messages')
    content = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    scheduled_for = models.DateTimeField(null=True, blank=True)
    injected_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=[
        ('pending', 'Pending'),
        ('injected', 'Injected'),
        ('cancelled', 'Cancelled'),
    ], default='pending')
    
    class Meta:
        ordering = ['created_at']
    
    def __str__(self):
        return f"{self.content[:50]} - {self.status}"


class MessageHistory(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    terminal_session = models.ForeignKey(TerminalSession, on_delete=models.CASCADE, related_name='message_history')
    message = models.TextField()
    timestamp = models.DateTimeField(auto_now_add=True)
    source = models.CharField(max_length=20, choices=[
        ('manual', 'Manual'),
        ('auto', 'Auto'),
        ('voice', 'Voice'),
    ], default='manual')
    
    class Meta:
        ordering = ['-timestamp']
    
    def __str__(self):
        return f"{self.message[:50]} - {self.timestamp}"
