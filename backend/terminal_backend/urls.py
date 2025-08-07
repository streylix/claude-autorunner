"""
URL configuration for terminal_backend project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/4.2/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""

from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static

urlpatterns = [
    # CORE FUNCTIONALITY ONLY - Simplified backend for 3 essential features:
    # 1. ccusage (pricing) - credit card usage tracking
    # 2. addmsg (message_queue) - add messages to terminal queue  
    # 3. audio transcription (voice_transcription) - Whisper audio processing
    path("", include("pricing.urls")),                    # ccusage functionality
    path("api/queue/", include("message_queue.urls")),    # addmsg functionality  
    path("api/voice/", include("voice_transcription.urls")), # audio transcribing
    
    # REMOVED: admin, terminal sessions, settings, todos - all moved to frontend-only
    # This eliminates the problematic terminal state persistence and database bloat
]

# Serve media files in development
if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
