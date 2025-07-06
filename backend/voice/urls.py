from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import VoiceTranscriptionViewSet

router = DefaultRouter()
router.register(r'transcriptions', VoiceTranscriptionViewSet)

urlpatterns = [
    path('', include(router.urls)),
]