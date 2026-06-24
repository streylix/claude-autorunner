"""Optional shared-secret auth for the Django API.

Design constraints (see audit + CLAUDE.md):
  * The headline network fix is binding the published port to 127.0.0.1
    (docker-compose). In this Docker setup the host bind is the ONLY effective
    network boundary: docker's userland proxy masquerades every host/LAN client
    to the same bridge-gateway IP inside the container, so an in-container IP
    filter cannot distinguish localhost from LAN. IP allow-listing is therefore
    NOT used as the boundary.
  * This permission is defense-in-depth on top of the loopback bind. It is
    OPT-IN: when CCBOT_API_TOKEN is unset (the default) every request is
    allowed, preserving the current behavior so the no-token manager TTS curl
    keeps working across a backend recreate. Enabling the token requires every
    client to send the X-CCBOT-API-Token header, so coordinate before turning
    it on.
"""

import hmac
import os

from rest_framework.permissions import BasePermission
from rest_framework.throttling import SimpleRateThrottle

TOKEN_HEADER = 'HTTP_X_CCBOT_API_TOKEN'
_LOOPBACK = {'127.0.0.1', '::1'}


def _configured_token() -> str:
    return os.environ.get('CCBOT_API_TOKEN', '') or ''


class TokenOrOpen(BasePermission):
    """Allow when no token is configured; otherwise require the header token.

    Loopback callers (the non-docker venv flow, container healthcheck) are
    always allowed so health/dev paths never lock themselves out.
    """

    message = 'Missing or invalid X-CCBOT-API-Token.'

    def has_permission(self, request, view) -> bool:
        token = _configured_token()
        # Opt-in: no token configured -> behave exactly like AllowAny.
        if not token:
            return True
        # Real loopback (venv flow / healthcheck) is trusted.
        if (request.META.get('REMOTE_ADDR') or '') in _LOOPBACK:
            return True
        presented = request.META.get(TOKEN_HEADER, '') or ''
        # Constant-time compare to avoid leaking the token byte-by-byte.
        return bool(presented) and hmac.compare_digest(presented, token)


class _ScopedThrottle(SimpleRateThrottle):
    """SimpleRateThrottle whose rate comes from DEFAULT_THROTTLE_RATES[scope].

    Subclasses set `scope`; SimpleRateThrottle looks up the rate by that scope.
    Throttled per source identity (IP/forwarded). Used on the heavy inference
    POSTs only — GET polling endpoints stay unthrottled.
    """

    def get_cache_key(self, request, view):
        return self.cache_format % {
            'scope': self.scope,
            'ident': self.get_ident(request),
        }


class TTSSpeakThrottle(_ScopedThrottle):
    scope = 'tts_speak'


class VoiceTranscribeThrottle(_ScopedThrottle):
    scope = 'voice_transcribe'
