from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response
from django.utils import timezone
from .models import TodoItem, TodoGeneration
from .serializers import TodoItemSerializer, TodoGenerationSerializer
from .services import TodoGenerationService
from terminal.models import TerminalSession


class TodoItemViewSet(viewsets.ModelViewSet):
    queryset = TodoItem.objects.all()
    serializer_class = TodoItemSerializer
    
    def get_queryset(self):
        queryset = super().get_queryset()
        terminal_session_id = self.request.query_params.get('terminal_session')
        if terminal_session_id:
            queryset = queryset.filter(terminal_session_id=terminal_session_id)
        
        completed = self.request.query_params.get('completed')
        if completed is not None:
            queryset = queryset.filter(completed=completed.lower() == 'true')
        
        auto_generated = self.request.query_params.get('auto_generated')
        if auto_generated is not None:
            queryset = queryset.filter(auto_generated=auto_generated.lower() == 'true')
            
        return queryset
    
    @action(detail=True, methods=['post'])
    def toggle_completed(self, request, pk=None):
        """Toggle the completed status of a todo item"""
        todo = self.get_object()
        todo.completed = not todo.completed
        
        if todo.completed:
            todo.completed_at = timezone.now()
        else:
            todo.completed_at = None
            
        todo.save()
        
        serializer = self.get_serializer(todo)
        return Response(serializer.data)
    
    @action(detail=False, methods=['post'])
    def clear_completed(self, request):
        """Delete all completed todos for a terminal session or all sessions"""
        terminal_session_id = request.data.get('terminal_session')
        clear_all_sessions = request.data.get('clear_all_sessions', False)
        
        if clear_all_sessions:
            # Clear all completed todos regardless of session
            deleted_count = TodoItem.objects.filter(completed=True).delete()[0]
        elif terminal_session_id:
            # Clear completed todos for specific session
            deleted_count = TodoItem.objects.filter(
                terminal_session_id=terminal_session_id,
                completed=True
            ).delete()[0]
        else:
            return Response({'error': 'terminal_session or clear_all_sessions is required'}, status=status.HTTP_400_BAD_REQUEST)
        
        return Response({'deleted_count': deleted_count})
    
    @action(detail=False, methods=['post'])
    def generate_from_output(self, request):
        """Generate todo items from terminal output using GPT-4o-mini"""
        print(f"[DEBUG] generate_from_output called with data: {request.data}")
        
        terminal_session_id = request.data.get('terminal_session')
        terminal_output = request.data.get('terminal_output')
        terminal_id = request.data.get('terminal_id', 1)  # Default to 1 if not provided
        mode = request.data.get('mode', 'verify')  # Default to verify mode
        custom_prompt = request.data.get('custom_prompt', '')
        
        print(f"[DEBUG] terminal_session_id: {terminal_session_id}")
        print(f"[DEBUG] terminal_id: {terminal_id}")
        print(f"[DEBUG] mode: {mode}")
        print(f"[DEBUG] terminal_output length: {len(terminal_output) if terminal_output else 0}")
        
        if not terminal_session_id:
            print("[DEBUG] Error: terminal_session is required")
            return Response({'error': 'terminal_session is required'}, status=status.HTTP_400_BAD_REQUEST)
        
        if not terminal_output:
            print("[DEBUG] Error: terminal_output is required")
            return Response({'error': 'terminal_output is required'}, status=status.HTTP_400_BAD_REQUEST)
        
        try:
            terminal_session = TerminalSession.objects.get(id=terminal_session_id)
            print(f"[DEBUG] Found terminal session: {terminal_session}")
        except TerminalSession.DoesNotExist:
            print(f"[DEBUG] Terminal session not found: {terminal_session_id}")
            return Response({'error': 'Terminal session not found'}, status=status.HTTP_404_NOT_FOUND)
        
        # Check if OpenAI API key is configured
        print("[DEBUG] Creating TodoGenerationService...")
        try:
            service = TodoGenerationService()
            print("[DEBUG] TodoGenerationService created successfully")
        except Exception as e:
            print(f"[DEBUG] Error creating TodoGenerationService: {e}")
            return Response({'error': f'Service initialization failed: {str(e)}'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
            
        if not service.is_api_key_configured():
            print("[DEBUG] OpenAI API key not configured")
            return Response({
                'error': 'OpenAI API key is not configured. Please set OPENAI_API_KEY in your .env file.'
            }, status=status.HTTP_400_BAD_REQUEST)
        
        print("[DEBUG] Calling service.generate_todos_from_output")
        # Generate todos
        result = service.generate_todos_from_output(terminal_output, terminal_session, terminal_id, mode, custom_prompt)
        
        print(f"[DEBUG] Service result: {result}")
        
        if 'error' in result:
            print(f"[DEBUG] Returning error response: {result}")
            return Response(result, status=status.HTTP_400_BAD_REQUEST)
        
        print(f"[DEBUG] Returning success response: {result}")
        return Response(result, status=status.HTTP_201_CREATED)


class TodoGenerationViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = TodoGeneration.objects.all()
    serializer_class = TodoGenerationSerializer
    
    def get_queryset(self):
        queryset = super().get_queryset()
        terminal_session_id = self.request.query_params.get('terminal_session')
        if terminal_session_id:
            queryset = queryset.filter(terminal_session_id=terminal_session_id)
        return queryset
