from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import TerminalSessionViewSet, TerminalCommandViewSet

router = DefaultRouter()
router.register(r'sessions', TerminalSessionViewSet)
router.register(r'commands', TerminalCommandViewSet)

urlpatterns = [
    path('', include(router.urls)),
]