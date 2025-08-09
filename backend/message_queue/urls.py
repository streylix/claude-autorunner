from django.urls import path
from . import views

urlpatterns = [
    # Simple pass-through endpoint for addmsg command
    path('add/', views.add_message_trigger, name='add_message_trigger'),
    
    # Simple pass-through endpoint for clear queue command
    path('clear/', views.clear_queue_trigger, name='clear_queue_trigger'),
    
    # Health check endpoint
    path('health/', views.health_check, name='health_check'),
]