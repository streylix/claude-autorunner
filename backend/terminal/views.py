from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response
from .models import TerminalSession, TerminalCommand, ApplicationStatistics
from .serializers import TerminalSessionSerializer, TerminalCommandSerializer, ApplicationStatisticsSerializer


class TerminalSessionViewSet(viewsets.ModelViewSet):
    queryset = TerminalSession.objects.all()
    serializer_class = TerminalSessionSerializer
    
    @action(detail=True, methods=['post'])
    def execute_command(self, request, pk=None):
        session = self.get_object()
        command = request.data.get('command')
        
        if not command:
            return Response({'error': 'Command is required'}, status=status.HTTP_400_BAD_REQUEST)
        
        # Create command record
        cmd = TerminalCommand.objects.create(
            session=session,
            command=command
        )
        
        # Here we would normally execute the command via WebSocket
        # For now, we just store it
        
        serializer = TerminalCommandSerializer(cmd)
        return Response(serializer.data, status=status.HTTP_201_CREATED)
    
    @action(detail=True, methods=['get'])
    def history(self, request, pk=None):
        session = self.get_object()
        commands = session.commands.all()
        serializer = TerminalCommandSerializer(commands, many=True)
        return Response(serializer.data)


class TerminalCommandViewSet(viewsets.ModelViewSet):
    queryset = TerminalCommand.objects.all()
    serializer_class = TerminalCommandSerializer


class ApplicationStatisticsViewSet(viewsets.ModelViewSet):
    queryset = ApplicationStatistics.objects.all()
    serializer_class = ApplicationStatisticsSerializer
    lookup_field = 'session_id'
    
    def get_object(self):
        try:
            return ApplicationStatistics.objects.get(session_id=self.kwargs['session_id'])
        except ApplicationStatistics.DoesNotExist:
            # Create new statistics record if it doesn't exist
            return ApplicationStatistics.objects.create(session_id=self.kwargs['session_id'])
    
    @action(detail=True, methods=['post'])
    def update_stats(self, request, session_id=None):
        stats = self.get_object()
        
        # Update stats with provided data
        for field in ['current_directory', 'injection_count', 'keyword_count', 
                     'plan_count', 'terminal_count', 'active_terminal_id', 'terminal_id_counter']:
            if field in request.data:
                setattr(stats, field, request.data[field])
        
        stats.save()
        serializer = self.get_serializer(stats)
        return Response(serializer.data)
