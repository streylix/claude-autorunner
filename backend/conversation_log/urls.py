from django.urls import path

from . import views

app_name = "conversation_log"

urlpatterns = [
    path("messages/", views.messages, name="messages"),
    path("open-asks/", views.open_asks, name="open-asks"),
]
