from django.db import models
import uuid


class UserSetting(models.Model):
    """Model to store user settings"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    key = models.CharField(max_length=255, unique=True)
    value = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        db_table = 'user_settings'
    
    def __str__(self):
        return f"{self.key}: {self.value[:50]}..."
