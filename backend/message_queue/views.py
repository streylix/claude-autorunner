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
        terminal_id = self.request.query_params.get('terminal_id')
        if terminal_id:
            queryset = queryset.filter(terminal_id=terminal_id)
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
            terminal_id=message.terminal_id,
            message=message.content,
            source='auto'
        )
        
        serializer = self.get_serializer(message)
        return Response(serializer.data)
    
    @action(detail=False, methods=['post'])
    def clear_queue(self, request):
        terminal_id = request.data.get('terminal_id')
        if terminal_id:
            QueuedMessage.objects.filter(
                terminal_id=terminal_id,
                status='pending'
            ).update(status='cancelled')
        return Response({'status': 'Queue cleared'})
    
    @action(detail=False, methods=['get', 'post'])
    def sync_trigger(self, request):
        """Trigger immediate sync notification for frontend"""
        # This endpoint is called by addmsg to notify frontend of new messages
        # We'll store the trigger timestamp for the frontend to check
        trigger_time = timezone.now().isoformat()
        return Response({
            'status': 'sync_triggered',
            'timestamp': trigger_time,
            'message': 'Frontend should sync messages now'
        })


class MessageHistoryViewSet(viewsets.ModelViewSet):
    queryset = MessageHistory.objects.all()
    serializer_class = MessageHistorySerializer
    
    def get_queryset(self):
        queryset = super().get_queryset()
        terminal_id = self.request.query_params.get('terminal_id')
        if terminal_id:
            queryset = queryset.filter(terminal_id=terminal_id)
        return queryset
