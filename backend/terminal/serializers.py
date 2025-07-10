from rest_framework import serializers
from .models import TerminalSession, TerminalCommand, ApplicationStatistics


class TerminalCommandSerializer(serializers.ModelSerializer):
    class Meta:
        model = TerminalCommand
        fields = ['id', 'command', 'output', 'timestamp', 'exit_code']
        read_only_fields = ['id', 'timestamp']


class TerminalSessionSerializer(serializers.ModelSerializer):
    commands = TerminalCommandSerializer(many=True, read_only=True)
    
    class Meta:
        model = TerminalSession
        fields = ['id', 'name', 'created_at', 'updated_at', 'is_active', 'current_directory', 
                 'color', 'frontend_terminal_id', 'position_index', 'commands']
        read_only_fields = ['id', 'created_at', 'updated_at']


class ApplicationStatisticsSerializer(serializers.ModelSerializer):
    class Meta:
        model = ApplicationStatistics
        fields = ['id', 'session_id', 'created_at', 'updated_at', 'current_directory', 
                 'injection_count', 'keyword_count', 'plan_count', 'terminal_count', 
                 'active_terminal_id', 'terminal_id_counter']
        read_only_fields = ['id', 'created_at', 'updated_at']