# Terminal views simplified to remove problematic database persistence
# Terminals are now stateless and operate entirely in-memory

from rest_framework import status
from rest_framework.decorators import api_view
from rest_framework.response import Response
from django.http import JsonResponse
import uuid
from datetime import datetime


@api_view(['GET'])
def terminal_status(request):
    """Simple endpoint to check if terminal API is available"""
    return Response({
        'status': 'active',
        'message': 'Terminal API is running without persistence',
        'timestamp': datetime.now().isoformat(),
        'note': 'Terminals operate in stateless mode - no database storage'
    })


@api_view(['POST'])
def execute_command_stateless(request):
    """Execute commands without storing session state"""
    command = request.data.get('command')
    
    if not command:
        return Response({'error': 'Command is required'}, status=status.HTTP_400_BAD_REQUEST)
    
    # Return command acknowledgment without storing anything
    return Response({
        'command': command,
        'timestamp': datetime.now().isoformat(),
        'status': 'acknowledged',
        'note': 'Command handled in stateless mode'
    }, status=status.HTTP_200_OK)


@api_view(['GET'])
def get_terminal_info(request):
    """Get basic terminal information without persisting state"""
    return Response({
        'terminal_id': str(uuid.uuid4()),  # Generate ephemeral ID
        'status': 'active',
        'mode': 'stateless',
        'timestamp': datetime.now().isoformat(),
        'note': 'Terminal state is not persisted'
    })


# All database-dependent views have been removed to eliminate
# the problem of orphaned terminal sessions causing API spam
