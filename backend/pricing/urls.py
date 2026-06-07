from django.urls import path
from . import views

# The DRF router/PricingViewSet was removed: nothing in the frontend calls the
# CRUD/cached endpoints. The PricingData/PricingCache models are kept. Only the
# simple ccusage endpoint remains (and it 503s when npx is unavailable, e.g. in
# the Docker image which ships no Node).
urlpatterns = [
    path('api/ccusage/', views.execute_ccusage_simple, name='execute_ccusage_simple'),
]
