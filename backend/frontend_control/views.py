from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from django.utils import timezone
import json
import os


def create_trigger_file(trigger_type, data=None):
    """Helper function to create trigger files for frontend notification"""
    trigger_file = f'/tmp/claude-code-{trigger_type}-trigger'
    trigger_content = f"{int(timezone.now().timestamp())}:{trigger_type}"
    if data:
        trigger_content += f":{json.dumps(data)}"
    
    with open(trigger_file, 'w') as f:
        f.write(trigger_content)
    
    return True


# Timer Control Endpoints

@csrf_exempt
@require_http_methods(["POST"])
def timer_start(request):
    """Start the timer in the frontend"""
    try:
        create_trigger_file('timer-start')
        
        return JsonResponse({
            'success': True,
            'action': 'start',
            'status': 'Timer started',
            'timestamp': timezone.now().isoformat()
        })
    except Exception as e:
        return JsonResponse(
            {'error': f'Failed to start timer: {str(e)}'}, 
            status=500
        )


@csrf_exempt
@require_http_methods(["POST"])
def timer_stop(request):
    """Stop the timer in the frontend"""
    try:
        create_trigger_file('timer-stop')
        
        return JsonResponse({
            'success': True,
            'action': 'stop',
            'status': 'Timer stopped',
            'timestamp': timezone.now().isoformat()
        })
    except Exception as e:
        return JsonResponse(
            {'error': f'Failed to stop timer: {str(e)}'}, 
            status=500
        )


@csrf_exempt
@require_http_methods(["POST"])
def timer_pause(request):
    """Pause the timer in the frontend"""
    try:
        create_trigger_file('timer-pause')
        
        return JsonResponse({
            'success': True,
            'action': 'pause',
            'status': 'Timer paused',
            'timestamp': timezone.now().isoformat()
        })
    except Exception as e:
        return JsonResponse(
            {'error': f'Failed to pause timer: {str(e)}'}, 
            status=500
        )


@csrf_exempt
@require_http_methods(["POST"])
def timer_resume(request):
    """Resume the timer in the frontend"""
    try:
        create_trigger_file('timer-resume')
        
        return JsonResponse({
            'success': True,
            'action': 'resume',
            'status': 'Timer resumed',
            'timestamp': timezone.now().isoformat()
        })
    except Exception as e:
        return JsonResponse(
            {'error': f'Failed to resume timer: {str(e)}'}, 
            status=500
        )


@csrf_exempt
@require_http_methods(["POST"])
def timer_reset(request):
    """Reset the timer in the frontend"""
    try:
        create_trigger_file('timer-reset')
        
        return JsonResponse({
            'success': True,
            'action': 'reset',
            'status': 'Timer reset',
            'timestamp': timezone.now().isoformat()
        })
    except Exception as e:
        return JsonResponse(
            {'error': f'Failed to reset timer: {str(e)}'}, 
            status=500
        )


@csrf_exempt
@require_http_methods(["POST"])
def timer_set(request):
    """Set the timer to a specific duration"""
    try:
        data = json.loads(request.body.decode('utf-8'))
        hours = data.get('hours', 0)
        minutes = data.get('minutes', 0)
        seconds = data.get('seconds', 0)
        
        # Validate input
        if not isinstance(hours, int) or not isinstance(minutes, int) or not isinstance(seconds, int):
            return JsonResponse(
                {'error': 'Hours, minutes, and seconds must be integers'}, 
                status=400
            )
        
        if hours < 0 or minutes < 0 or seconds < 0:
            return JsonResponse(
                {'error': 'Time values cannot be negative'}, 
                status=400
            )
        
        if minutes >= 60 or seconds >= 60:
            return JsonResponse(
                {'error': 'Minutes and seconds must be less than 60'}, 
                status=400
            )
        
        timer_data = {
            'hours': hours,
            'minutes': minutes,
            'seconds': seconds
        }
        
        create_trigger_file('timer-set', timer_data)
        
        time_str = f"{hours:02d}:{minutes:02d}:{seconds:02d}"
        
        return JsonResponse({
            'success': True,
            'action': 'set',
            'time': time_str,
            'status': f'Timer set to {time_str}',
            'timestamp': timezone.now().isoformat()
        })
    except Exception as e:
        return JsonResponse(
            {'error': f'Failed to set timer: {str(e)}'}, 
            status=500
        )


@csrf_exempt
@require_http_methods(["GET"])
def timer_status(request):
    """Get the current timer status from the frontend"""
    try:
        # Read status from a shared status file (frontend should update this)
        status_file = '/tmp/claude-code-timer-status'
        
        if os.path.exists(status_file):
            with open(status_file, 'r') as f:
                status_data = json.loads(f.read())
                
            return JsonResponse({
                'success': True,
                **status_data,
                'timestamp': timezone.now().isoformat()
            })
        else:
            # Default response if no status file
            return JsonResponse({
                'success': True,
                'running': False,
                'paused': False,
                'time': '00:00:00',
                'elapsed_seconds': 0,
                'timestamp': timezone.now().isoformat()
            })
    except Exception as e:
        return JsonResponse(
            {'error': f'Failed to get timer status: {str(e)}'}, 
            status=500
        )


# Terminal Control Endpoints

@csrf_exempt
@require_http_methods(["POST"])
def terminal_switch(request):
    """Switch active terminal in the frontend"""
    try:
        data = json.loads(request.body.decode('utf-8'))
        terminal_id = data.get('terminal_id', 1)
        
        if not isinstance(terminal_id, int) or terminal_id < 1 or terminal_id > 4:
            return JsonResponse(
                {'error': 'Terminal ID must be between 1 and 4'}, 
                status=400
            )
        
        create_trigger_file('terminal-switch', {'terminal_id': terminal_id})
        
        return JsonResponse({
            'success': True,
            'active_terminal': terminal_id,
            'status': f'Switched to Terminal {terminal_id}',
            'timestamp': timezone.now().isoformat()
        })
    except Exception as e:
        return JsonResponse(
            {'error': f'Failed to switch terminal: {str(e)}'}, 
            status=500
        )


@csrf_exempt
@require_http_methods(["GET"])
def terminal_status(request):
    """Get the status of all terminals from the frontend"""
    try:
        import time
        # Request terminal status from frontend by creating trigger file
        trigger_file = '/tmp/claude-code-terminal-status-trigger'
        response_file = '/tmp/claude-code-terminal-status-response'
        
        # Clean up old response file
        if os.path.exists(response_file):
            os.remove(response_file)
        
        # Create trigger file to request status from frontend
        with open(trigger_file, 'w') as f:
            json.dump({'request': 'terminal_status', 'timestamp': timezone.now().isoformat()}, f)
        
        # Wait for frontend to respond (max 2 seconds)
        wait_time = 0
        while wait_time < 2:
            if os.path.exists(response_file):
                try:
                    with open(response_file, 'r') as f:
                        frontend_data = json.load(f)
                    
                    # Clean up files
                    if os.path.exists(trigger_file):
                        os.remove(trigger_file)
                    
                    # Return the frontend data directly
                    return JsonResponse({
                        'success': True,
                        'active_terminal': frontend_data.get('activeTerminal', 1),
                        'terminals': frontend_data.get('terminals', {}),
                        'timestamp': timezone.now().isoformat()
                    })
                except (json.JSONDecodeError, Exception) as e:
                    logger.warning(f"Error reading terminal response: {e}")
            
            time.sleep(0.1)
            wait_time += 0.1
        
        # Clean up trigger file if still exists
        if os.path.exists(trigger_file):
            os.remove(trigger_file)
        
        # Fallback if frontend doesn't respond - return default terminals
        return JsonResponse({
            'success': True,
            'active_terminal': 1,
            'terminals': {
                '1': {'name': 'Terminal 1', 'running': False, 'current_command': None},
                '2': {'name': 'Terminal 2', 'running': False, 'current_command': None},
                '3': {'name': 'Terminal 3', 'running': False, 'current_command': None},
                '4': {'name': 'Terminal 4', 'running': False, 'current_command': None}
            },
            'timestamp': timezone.now().isoformat()
        })
    except Exception as e:
        return JsonResponse(
            {'error': f'Failed to get terminal status: {str(e)}'}, 
            status=500
        )


# Plan Mode Control

@csrf_exempt
@require_http_methods(["POST"])
def planmode_toggle(request):
    """Toggle plan mode in the frontend"""
    try:
        create_trigger_file('planmode-toggle')
        
        # Read current status to determine new state
        status_file = '/tmp/claude-code-planmode-status'
        plan_mode_enabled = False
        
        if os.path.exists(status_file):
            with open(status_file, 'r') as f:
                current_status = json.loads(f.read())
                plan_mode_enabled = not current_status.get('enabled', False)
        
        return JsonResponse({
            'success': True,
            'plan_mode_enabled': plan_mode_enabled,
            'status': f'Plan mode {"enabled" if plan_mode_enabled else "disabled"}',
            'timestamp': timezone.now().isoformat()
        })
    except Exception as e:
        return JsonResponse(
            {'error': f'Failed to toggle plan mode: {str(e)}'}, 
            status=500
        )


@csrf_exempt
@require_http_methods(["GET"])
def planmode_status(request):
    """Get the current plan mode status"""
    try:
        status_file = '/tmp/claude-code-planmode-status'
        
        if os.path.exists(status_file):
            with open(status_file, 'r') as f:
                status_data = json.loads(f.read())
                
            return JsonResponse({
                'success': True,
                'plan_mode_enabled': status_data.get('enabled', False),
                'timestamp': timezone.now().isoformat()
            })
        else:
            return JsonResponse({
                'success': True,
                'plan_mode_enabled': False,
                'timestamp': timezone.now().isoformat()
            })
    except Exception as e:
        return JsonResponse(
            {'error': f'Failed to get plan mode status: {str(e)}'}, 
            status=500
        )


# Auto-Continue Control

@csrf_exempt
@require_http_methods(["POST"])
def autocontinue_toggle(request):
    """Toggle auto-continue mode in the frontend"""
    try:
        create_trigger_file('autocontinue-toggle')
        
        # Read current status to determine new state
        status_file = '/tmp/claude-code-autocontinue-status'
        auto_continue_enabled = False
        
        if os.path.exists(status_file):
            with open(status_file, 'r') as f:
                current_status = json.loads(f.read())
                auto_continue_enabled = not current_status.get('enabled', False)
        
        return JsonResponse({
            'success': True,
            'auto_continue_enabled': auto_continue_enabled,
            'status': f'Auto-continue {"enabled" if auto_continue_enabled else "disabled"}',
            'timestamp': timezone.now().isoformat()
        })
    except Exception as e:
        return JsonResponse(
            {'error': f'Failed to toggle auto-continue: {str(e)}'}, 
            status=500
        )


# Injection Control

@csrf_exempt
@require_http_methods(["POST"])
def injection_pause(request):
    """Pause message injection in the frontend"""
    try:
        create_trigger_file('injection-pause')
        
        return JsonResponse({
            'success': True,
            'injection_paused': True,
            'status': 'Injection paused',
            'timestamp': timezone.now().isoformat()
        })
    except Exception as e:
        return JsonResponse(
            {'error': f'Failed to pause injection: {str(e)}'}, 
            status=500
        )


@csrf_exempt
@require_http_methods(["POST"])
def injection_resume(request):
    """Resume message injection in the frontend"""
    try:
        create_trigger_file('injection-resume')
        
        return JsonResponse({
            'success': True,
            'injection_paused': False,
            'status': 'Injection resumed',
            'timestamp': timezone.now().isoformat()
        })
    except Exception as e:
        return JsonResponse(
            {'error': f'Failed to resume injection: {str(e)}'}, 
            status=500
        )


@csrf_exempt
@require_http_methods(["POST"])
def injection_manual(request):
    """Manually trigger injection of next message in queue"""
    try:
        create_trigger_file('injection-manual')
        
        return JsonResponse({
            'success': True,
            'message_injected': True,
            'status': 'Manual injection triggered',
            'timestamp': timezone.now().isoformat()
        })
    except Exception as e:
        return JsonResponse(
            {'error': f'Failed to trigger manual injection: {str(e)}'}, 
            status=500
        )


# Queue Status (Read-Only)

@csrf_exempt
@require_http_methods(["GET"])
def queue_status(request):
    """Get the current queue status from the frontend"""
    try:
        terminal_id = request.GET.get('terminal_id')
        
        # Read status from a shared status file (frontend should update this)
        status_file = '/tmp/claude-code-queue-status'
        
        if os.path.exists(status_file):
            with open(status_file, 'r') as f:
                status_data = json.loads(f.read())
                
            # Filter by terminal if requested
            if terminal_id:
                terminal_key = f'terminal_{terminal_id}'
                if terminal_key in status_data.get('terminals', {}):
                    return JsonResponse({
                        'success': True,
                        'terminal_id': terminal_id,
                        'count': status_data['terminals'][terminal_key].get('count', 0),
                        'messages': status_data['terminals'][terminal_key].get('messages', []),
                        'timestamp': timezone.now().isoformat()
                    })
                else:
                    return JsonResponse({
                        'success': True,
                        'terminal_id': terminal_id,
                        'count': 0,
                        'messages': [],
                        'timestamp': timezone.now().isoformat()
                    })
            
            return JsonResponse({
                'success': True,
                **status_data,
                'timestamp': timezone.now().isoformat()
            })
        else:
            # Default response if no status file
            return JsonResponse({
                'success': True,
                'total_messages': 0,
                'terminals': {},
                'timestamp': timezone.now().isoformat()
            })
    except Exception as e:
        return JsonResponse(
            {'error': f'Failed to get queue status: {str(e)}'}, 
            status=500
        )