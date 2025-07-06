from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response
from .models import TerminalSession, TerminalCommand
from .serializers import TerminalSessionSerializer, TerminalCommandSerializer


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
