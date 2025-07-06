from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import TodoItemViewSet, TodoGenerationViewSet

router = DefaultRouter()
router.register(r'items', TodoItemViewSet)
router.register(r'generations', TodoGenerationViewSet)

urlpatterns = [
    path('', include(router.urls)),
]