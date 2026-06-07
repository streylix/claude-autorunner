from django.urls import path
from . import views

urlpatterns = [
    # Health check endpoint (used by docker-compose healthcheck)
    path('health/', views.health_check, name='health_check'),
]
