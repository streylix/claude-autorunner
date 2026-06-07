"""
ASGI config for terminal_backend project.

It exposes the ASGI callable as a module-level variable named ``application``.

The backend exposes HTTP only — there are no WebSocket consumers. Daphne still
serves the app via this ASGI entrypoint (see Dockerfile CMD). The plain Django
ASGI application is sufficient for HTTP-only serving.

For more information on this file, see
https://docs.djangoproject.com/en/4.2/howto/deployment/asgi/
"""

import os
from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "terminal_backend.settings")

application = get_asgi_application()
