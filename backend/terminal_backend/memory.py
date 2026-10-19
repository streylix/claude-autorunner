"""
Return freed heap to the OS after the heavy voice endpoints.

Why this exists (T619): the daphne process grew to ~14GB (0.8GB RSS + 13GB
swap) over two weeks. Nothing Python-level was leaking — 10.4GB of it sat in
242 glibc per-thread malloc heaps. Django under ASGI runs every sync view on a
fresh thread (asgiref ThreadSensitiveContext), glibc hands those threads up to
8 x cores arenas, and each arena keeps the high-water mark of the large,
variable-size buffers Whisper (CPU int8 CTranslate2 + decode/VAD) and Kokoro
allocate per request. Freed chunks stay inside the arena forever unless someone
calls malloc_trim(), which madvise()s the free pages back across ALL arenas.

MALLOC_ARENA_MAX=2 (docker-compose.yml) caps the arena count; this trims what
the remaining arenas hold after each heavy request. Together they keep the
process near its live working set instead of ratcheting up.
"""

import ctypes
import ctypes.util
import logging

logger = logging.getLogger(__name__)

# Only these endpoints allocate large per-request buffers; trimming after every
# health poll or queue call would just be wasted syscalls.
HEAVY_PREFIXES = ("/api/voice/", "/api/tts/speak/", "/api/tts/health/")

try:
    _malloc_trim = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6").malloc_trim
    _malloc_trim.argtypes = [ctypes.c_size_t]
    _malloc_trim.restype = ctypes.c_int
except (OSError, AttributeError):  # non-glibc libc (musl/macOS venv): no-op
    _malloc_trim = None


def release_freed_memory() -> None:
    """Hand free heap pages in every glibc arena back to the OS."""
    if _malloc_trim is None:
        return
    try:
        _malloc_trim(0)
    except Exception as exc:  # never fail a request over housekeeping
        logger.debug(f"malloc_trim failed: {exc!r}")


class TrimHeapMiddleware:
    """Calls malloc_trim(0) after transcription / TTS / wake-check requests."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if _malloc_trim is not None and request.path.startswith(HEAVY_PREFIXES):
            release_freed_memory()
        return response
