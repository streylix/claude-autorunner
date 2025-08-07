# Signals temporarily disabled for simplified backend
# These used WebSocket functionality which has been removed for cleanup

# from django.db.models.signals import post_save, post_delete
# from django.dispatch import receiver
# from channels.layers import get_channel_layer
# from asgiref.sync import async_to_sync
# import json

# from .models import QueuedMessage

# All WebSocket signals have been removed to eliminate complexity
# The simplified backend only uses REST API endpoints