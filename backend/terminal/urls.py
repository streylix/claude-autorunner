from django.urls import path
from .views import terminal_status, execute_command_stateless, get_terminal_info

# Simplified URL patterns for stateless terminal operation
urlpatterns = [
    path('status/', terminal_status, name='terminal-status'),
    path('execute/', execute_command_stateless, name='execute-command'),
    path('info/', get_terminal_info, name='terminal-info'),
    # All database-dependent endpoints have been removed to prevent
    # orphaned session issues that caused 33+ API calls per second
]