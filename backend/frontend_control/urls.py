from django.urls import path
from . import views

urlpatterns = [
    # Timer control endpoints
    path('timer/start/', views.timer_start, name='timer_start'),
    path('timer/stop/', views.timer_stop, name='timer_stop'),
    path('timer/pause/', views.timer_pause, name='timer_pause'),
    path('timer/resume/', views.timer_resume, name='timer_resume'),
    path('timer/reset/', views.timer_reset, name='timer_reset'),
    path('timer/set/', views.timer_set, name='timer_set'),
    path('timer/status/', views.timer_status, name='timer_status'),
    
    # Terminal control endpoints
    path('terminal/switch/', views.terminal_switch, name='terminal_switch'),
    path('terminal/status/', views.terminal_status, name='terminal_status'),
    
    # Plan mode control
    path('planmode/toggle/', views.planmode_toggle, name='planmode_toggle'),
    path('planmode/status/', views.planmode_status, name='planmode_status'),
    
    # Auto-continue control
    path('autocontinue/toggle/', views.autocontinue_toggle, name='autocontinue_toggle'),
    
    # Injection control
    path('injection/pause/', views.injection_pause, name='injection_pause'),
    path('injection/resume/', views.injection_resume, name='injection_resume'),
    path('injection/manual/', views.injection_manual, name='injection_manual'),
    
    # Queue status (read-only)
    path('queue/status/', views.queue_status, name='queue_status'),
]