from django.db import models
import uuid

# Updated todos models to work without problematic terminal session persistence


class TodoItem(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # Removed terminal_session foreign key to eliminate orphaned session issues
    terminal_id = models.CharField(max_length=255, null=True, blank=True)  # Simple string reference
    title = models.CharField(max_length=500)
    description = models.TextField(blank=True)
    completed = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    priority = models.CharField(max_length=10, choices=[
        ('low', 'Low'),
        ('medium', 'Medium'),
        ('high', 'High'),
    ], default='medium')
    source_output = models.TextField(blank=True)  # Store the terminal output that generated this todo
    auto_generated = models.BooleanField(default=False)
    
    class Meta:
        ordering = ['-created_at']
    
    def __str__(self):
        return f"{self.title[:50]} - Terminal {self.terminal_id or 'unknown'}"


class TodoGeneration(models.Model):
    """Track todo generation attempts"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # Removed terminal_session foreign key to eliminate orphaned session issues
    terminal_id = models.CharField(max_length=255, null=True, blank=True)  # Simple string reference
    terminal_output = models.TextField()
    generated_at = models.DateTimeField(auto_now_add=True)
    status = models.CharField(max_length=20, choices=[
        ('pending', 'Pending'),
        ('processing', 'Processing'),
        ('completed', 'Completed'),
        ('failed', 'Failed'),
    ], default='pending')
    error_message = models.TextField(blank=True)
    todos_count = models.IntegerField(default=0)
    
    class Meta:
        ordering = ['-generated_at']
    
    def __str__(self):
        return f"Generation for Terminal {self.terminal_id or 'unknown'} - {self.status}"
