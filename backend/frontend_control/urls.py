from django.urls import path
from . import views

urlpatterns = [
    # Frontend log shipping (entries echoed to stdout for docker logs)
    path('logs/frontend/', views.frontend_logs, name='frontend_logs'),
]
