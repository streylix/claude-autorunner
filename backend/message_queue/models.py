from django.db import models
import uuid

# Message models updated to work without problematic terminal session persistence


class QueuedMessage(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # Removed terminal_session foreign key to eliminate orphaned session issues
    terminal_id = models.CharField(max_length=255, null=True, blank=True)  # Simple string reference
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
    # Removed terminal_session foreign key to eliminate orphaned session issues
    terminal_id = models.CharField(max_length=255, null=True, blank=True)  # Simple string reference
    message = models.TextField()
    timestamp = models.DateTimeField(auto_now_add=True)
    source = models.CharField(max_length=20, choices=[
        ('manual', 'Manual'),
        ('auto', 'Auto'),
        ('voice', 'Voice'),
    ], default='manual')
    counter = models.IntegerField(null=True, blank=True)
    
    class Meta:
        ordering = ['-timestamp']
    
    def __str__(self):
        return f"{self.message[:50]} - {self.timestamp}"
