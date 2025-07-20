from django.urls import path
from . import views

app_name = 'voice_transcription'

urlpatterns = [
    path('transcribe/', views.transcribe_audio, name='transcribe_audio'),
    path('health/', views.health_check, name='health_check'),
    path('list/', views.list_transcriptions, name='list_transcriptions'),
    path('clear/', views.clear_transcriptions, name='clear_transcriptions'),
]