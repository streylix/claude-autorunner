from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import ApplicationSettingsViewSet

router = DefaultRouter()
router.register(r'app-settings', ApplicationSettingsViewSet)

urlpatterns = [
    path('', include(router.urls)),
]