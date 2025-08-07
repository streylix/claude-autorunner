from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response
from django.utils import timezone
from .models import TodoItem, TodoGeneration
from .serializers import TodoItemSerializer, TodoGenerationSerializer
from .services import TodoGenerationService
# TerminalSession import removed - using stateless terminal approach


class TodoItemViewSet(viewsets.ModelViewSet):
    queryset = TodoItem.objects.all()
    serializer_class = TodoItemSerializer
    
    def get_queryset(self):
        queryset = super().get_queryset()
        terminal_id = self.request.query_params.get('terminal_id')
        if terminal_id:
            queryset = queryset.filter(terminal_id=terminal_id)
        
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
        """Delete all completed todos for a terminal or all terminals"""
        terminal_id = request.data.get('terminal_id')
        clear_all_terminals = request.data.get('clear_all_terminals', False)
        
        if clear_all_terminals:
            # Clear all completed todos regardless of terminal
            deleted_count = TodoItem.objects.filter(completed=True).delete()[0]
        elif terminal_id:
            # Clear completed todos for specific terminal
            deleted_count = TodoItem.objects.filter(
                terminal_id=terminal_id,
                completed=True
            ).delete()[0]
        else:
            return Response({'error': 'terminal_id or clear_all_terminals is required'}, status=status.HTTP_400_BAD_REQUEST)
        
        return Response({'deleted_count': deleted_count})
    
    @action(detail=False, methods=['post'])
    def generate_from_output(self, request):
        """Generate todo items from terminal output using GPT-4o-mini"""
        print(f"[DEBUG] generate_from_output called with data: {request.data}")
        
        terminal_id = request.data.get('terminal_id')
        terminal_output = request.data.get('terminal_output')
        mode = request.data.get('mode', 'verify')  # Default to verify mode
        custom_prompt = request.data.get('custom_prompt', '')
        
        print(f"[DEBUG] terminal_id: {terminal_id}")
        print(f"[DEBUG] mode: {mode}")
        print(f"[DEBUG] terminal_output length: {len(terminal_output) if terminal_output else 0}")
        
        if not terminal_id:
            print("[DEBUG] Error: terminal_id is required")
            return Response({'error': 'terminal_id is required'}, status=status.HTTP_400_BAD_REQUEST)
        
        if not terminal_output:
            print("[DEBUG] Error: terminal_output is required")
            return Response({'error': 'terminal_output is required'}, status=status.HTTP_400_BAD_REQUEST)
        
        # Terminal sessions removed - operating in stateless mode
        print(f"[DEBUG] Using stateless mode for terminal: {terminal_id}")
        
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
        # Generate todos - using terminal_id for both session and terminal identification
        result = service.generate_todos_from_output(terminal_output, terminal_id, terminal_id, mode, custom_prompt)
        
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
        terminal_id = self.request.query_params.get('terminal_id')
        if terminal_id:
            queryset = queryset.filter(terminal_id=terminal_id)
        return queryset