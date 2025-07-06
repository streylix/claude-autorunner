from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response
from django.utils import timezone
from .models import QueuedMessage, MessageHistory
from .serializers import QueuedMessageSerializer, MessageHistorySerializer


class QueuedMessageViewSet(viewsets.ModelViewSet):
    queryset = QueuedMessage.objects.all()
    serializer_class = QueuedMessageSerializer
    
    def get_queryset(self):
        queryset = super().get_queryset()
        terminal_session_id = self.request.query_params.get('terminal_session')
        if terminal_session_id:
            queryset = queryset.filter(terminal_session_id=terminal_session_id)
        status_filter = self.request.query_params.get('status')
        if status_filter:
            queryset = queryset.filter(status=status_filter)
        return queryset
    
    @action(detail=True, methods=['post'])
    def inject(self, request, pk=None):
        message = self.get_object()
        if message.status != 'pending':
            return Response({'error': 'Message already processed'}, status=status.HTTP_400_BAD_REQUEST)
        
        message.status = 'injected'
        message.injected_at = timezone.now()
        message.save()
        
        # Create history entry
        MessageHistory.objects.create(
            terminal_session=message.terminal_session,
            message=message.content,
            source='auto'
        )
        
        serializer = self.get_serializer(message)
        return Response(serializer.data)
    
    @action(detail=False, methods=['post'])
    def clear_queue(self, request):
        terminal_session_id = request.data.get('terminal_session')
        if terminal_session_id:
            QueuedMessage.objects.filter(
                terminal_session_id=terminal_session_id,
                status='pending'
            ).update(status='cancelled')
        return Response({'status': 'Queue cleared'})


class MessageHistoryViewSet(viewsets.ModelViewSet):
    queryset = MessageHistory.objects.all()
    serializer_class = MessageHistorySerializer
    
    def get_queryset(self):
        queryset = super().get_queryset()
        terminal_session_id = self.request.query_params.get('terminal_session')
        if terminal_session_id:
            queryset = queryset.filter(terminal_session_id=terminal_session_id)
        return queryset
