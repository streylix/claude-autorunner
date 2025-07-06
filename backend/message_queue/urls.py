from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import QueuedMessageViewSet, MessageHistoryViewSet

router = DefaultRouter()
router.register(r'queue', QueuedMessageViewSet)
router.register(r'history', MessageHistoryViewSet)

urlpatterns = [
    path('', include(router.urls)),
]