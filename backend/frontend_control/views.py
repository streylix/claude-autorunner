import logging

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
import json


logger = logging.getLogger(__name__)


def _clean(s):
    """Collapse CR/LF and other C0 control chars to spaces so log input can't
    forge new log lines (log injection) in the shared stdout stream."""
    return ''.join(' ' if ord(c) < 0x20 else c for c in s)


@csrf_exempt
@require_http_methods(["POST"])
def frontend_logs(request):
    """Receive batched frontend log entries and print them to stdout so they
    appear in `docker logs` (tagged [frontend]) alongside Django's own logs."""
    try:
        data = json.loads(request.body)
        entries = data.get('entries', [])
        for entry in entries[:200]:  # sanity cap per batch
            ts = _clean(str(entry.get('ts', ''))[:24])
            level = _clean(str(entry.get('type', 'info'))[:10])
            # Strip CR/LF (and other control chars) so a crafted message can't
            # forge extra [frontend] lines in the shared stdout timeline.
            message = _clean(str(entry.get('message', ''))[:2000])
            print(f"[frontend] [{level}] {ts} {message}", flush=True)
        return JsonResponse({'success': True, 'received': len(entries)})
    except (json.JSONDecodeError, AttributeError) as e:
        return JsonResponse({'error': f'Invalid log payload: {str(e)}'}, status=400)
