from django.urls import path

from . import views

app_name = "text_to_speech"

urlpatterns = [
    path("speak/", views.speak, name="speak"),
    path("voices/", views.voices, name="voices"),
    path("config/", views.config, name="config"),
    path("notifications/", views.notifications, name="notifications"),
    path("notifications/<int:pk>/played/", views.mark_played, name="mark-played"),
    path("audio/<int:pk>/", views.audio, name="audio"),
    path("health/", views.health, name="health"),
]
