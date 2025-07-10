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
    
    # Enhanced terminal state fields
    color = models.CharField(max_length=7, default='#007acc')  # Hex color code
    frontend_terminal_id = models.IntegerField(null=True, blank=True)  # Frontend terminal ID mapping
    position_index = models.IntegerField(default=0)  # Order in terminal list
    
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


class ApplicationStatistics(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session_id = models.CharField(max_length=255, unique=True)  # Frontend session identifier
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    # Status section values
    current_directory = models.CharField(max_length=500, default='~')
    injection_count = models.IntegerField(default=0)
    keyword_count = models.IntegerField(default=0)
    plan_count = models.IntegerField(default=0)
    terminal_count = models.IntegerField(default=1)
    
    # Terminal state summary
    active_terminal_id = models.IntegerField(default=1)
    terminal_id_counter = models.IntegerField(default=1)
    
    class Meta:
        ordering = ['-updated_at']
    
    def __str__(self):
        return f"Stats for {self.session_id} - {self.injection_count} injections"
