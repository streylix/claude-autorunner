from django.db import models
from django.contrib.auth.models import User
import uuid


class TerminalSession(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    is_active = models.BooleanField(default=True)
    current_directory = models.CharField(max_length=500, default='~')
    
    class Meta:
        ordering = ['-created_at']
    
    def __str__(self):
        return f"Terminal {self.name} ({self.id})"


class TerminalCommand(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(TerminalSession, on_delete=models.CASCADE, related_name='commands')
    command = models.TextField()
    output = models.TextField(blank=True)
    timestamp = models.DateTimeField(auto_now_add=True)
    exit_code = models.IntegerField(null=True, blank=True)
    
    class Meta:
        ordering = ['timestamp']
    
    def __str__(self):
        return f"{self.command[:50]} - {self.timestamp}"
