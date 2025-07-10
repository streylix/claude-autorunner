from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import TerminalSessionViewSet, TerminalCommandViewSet, ApplicationStatisticsViewSet

router = DefaultRouter()
router.register(r'sessions', TerminalSessionViewSet)
router.register(r'commands', TerminalCommandViewSet)
router.register(r'stats', ApplicationStatisticsViewSet)

urlpatterns = [
    path('', include(router.urls)),
]