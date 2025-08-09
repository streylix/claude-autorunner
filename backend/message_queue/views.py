from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from django.utils import timezone
import json
import os


@csrf_exempt
@require_http_methods(["POST"])
def add_message_trigger(request):
    """
    Simple pass-through endpoint for addmsg command.
    Does NOT store messages in database - just triggers frontend notification.
    The frontend queue is the single source of truth for all messages.
    """
    try:
        # Parse JSON request body
        data = json.loads(request.body.decode('utf-8'))
        content = data.get('content', '')
        terminal_id = data.get('terminal_id', 'terminal_1')
        
        if not content:
            return JsonResponse(
                {'error': 'Message content is required'}, 
                status=400
            )
        
        # WebSocket functionality removed - using WSGI server
        print(f"[API] Processing message: {content} for {terminal_id}")
            
        # Fallback: Create file-based trigger for compatibility
        trigger_file = '/tmp/claude-code-addmsg-trigger'
        trigger_content = f"{int(timezone.now().timestamp())}:addmsg:{content}:{terminal_id}"
        
        with open(trigger_file, 'w') as f:
            f.write(trigger_content)
        
        # Return success response
        return JsonResponse({
            'status': 'success',
            'message': 'Message trigger sent to frontend',
            'content': content,
            'terminal_id': terminal_id,
            'timestamp': timezone.now().isoformat()
        })
        
    except Exception as e:
        return JsonResponse(
            {'error': f'Failed to trigger message: {str(e)}'}, 
            status=500
        )


@csrf_exempt
@require_http_methods(["POST"])
def clear_queue_trigger(request):
    """
    Simple pass-through endpoint for clear queue command.
    Does NOT clear any database - just triggers frontend notification to clear its queue.
    The frontend queue is the single source of truth for all messages.
    """
    try:
        # Parse JSON request body (optional parameters)
        data = json.loads(request.body.decode('utf-8')) if request.body else {}
        terminal_id = data.get('terminal_id', 'terminal_1')
        
        print(f"[API] Processing clear queue request for {terminal_id}")
            
        # Create file-based trigger for frontend to detect
        trigger_file = '/tmp/claude-code-clear-trigger'
        trigger_content = f"{int(timezone.now().timestamp())}:clear:{terminal_id}"
        
        with open(trigger_file, 'w') as f:
            f.write(trigger_content)
        
        # Return success response
        return JsonResponse({
            'status': 'success',
            'message': 'Clear queue trigger sent to frontend',
            'terminal_id': terminal_id,
            'timestamp': timezone.now().isoformat()
        })
        
    except Exception as e:
        return JsonResponse(
            {'error': f'Failed to trigger queue clear: {str(e)}'}, 
            status=500
        )


@csrf_exempt
@require_http_methods(["GET"])
def health_check(request):
    """Simple health check endpoint"""
    return JsonResponse({
        'status': 'healthy',
        'service': 'message-pass-through',
        'timestamp': timezone.now().isoformat()
    })