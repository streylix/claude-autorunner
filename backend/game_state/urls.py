from django.urls import path

from . import views

app_name = "game_state"

urlpatterns = [
    path("vibe-blast/", views.vibe_blast, name="vibe-blast"),
    path("health/", views.health, name="health"),
]
