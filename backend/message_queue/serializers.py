from rest_framework import serializers
from .models import QueuedMessage, MessageHistory


class QueuedMessageSerializer(serializers.ModelSerializer):
    class Meta:
        model = QueuedMessage
        fields = ['id', 'terminal_session', 'content', 'created_at', 'scheduled_for', 'injected_at', 'status']
        read_only_fields = ['id', 'created_at', 'injected_at']


class MessageHistorySerializer(serializers.ModelSerializer):
    class Meta:
        model = MessageHistory
        fields = ['id', 'terminal_session', 'message', 'timestamp', 'source', 'terminal_id', 'counter']
        read_only_fields = ['id', 'timestamp']