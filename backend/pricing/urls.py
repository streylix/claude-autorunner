from django.urls import path, include
from rest_framework.routers import DefaultRouter
from . import views

router = DefaultRouter()
router.register(r'pricing', views.PricingViewSet)

urlpatterns = [
    path('api/', include(router.urls)),
    path('api/ccusage/', views.execute_ccusage_simple, name='execute_ccusage_simple'),
]