from rest_framework import serializers
from .models import TodoItem, TodoGeneration


class TodoItemSerializer(serializers.ModelSerializer):
    class Meta:
        model = TodoItem
        fields = [
            'id', 'terminal_session', 'title', 'description', 'completed', 
            'created_at', 'completed_at', 'priority', 'source_output', 'auto_generated'
        ]
        read_only_fields = ['id', 'created_at', 'completed_at']

    def update(self, instance, validated_data):
        if 'completed' in validated_data and validated_data['completed'] and not instance.completed:
            from django.utils import timezone
            validated_data['completed_at'] = timezone.now()
        elif 'completed' in validated_data and not validated_data['completed']:
            validated_data['completed_at'] = None
        
        return super().update(instance, validated_data)


class TodoGenerationSerializer(serializers.ModelSerializer):
    class Meta:
        model = TodoGeneration
        fields = [
            'id', 'terminal_session', 'terminal_output', 'generated_at', 
            'status', 'error_message', 'todos_count'
        ]
        read_only_fields = ['id', 'generated_at', 'status', 'error_message', 'todos_count']