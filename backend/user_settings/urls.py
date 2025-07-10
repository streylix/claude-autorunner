from django.urls import path
from . import views

urlpatterns = [
    path('custom_prompt/', views.custom_prompt, name='custom_prompt'),
]