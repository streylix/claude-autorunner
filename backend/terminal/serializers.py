from rest_framework import serializers
from .models import TerminalSession, TerminalCommand


class TerminalCommandSerializer(serializers.ModelSerializer):
    class Meta:
        model = TerminalCommand
        fields = ['id', 'command', 'output', 'timestamp', 'exit_code']
        read_only_fields = ['id', 'timestamp']


class TerminalSessionSerializer(serializers.ModelSerializer):
    commands = TerminalCommandSerializer(many=True, read_only=True)
    
    class Meta:
        model = TerminalSession
        fields = ['id', 'name', 'created_at', 'updated_at', 'is_active', 'current_directory', 'commands']
        read_only_fields = ['id', 'created_at', 'updated_at']