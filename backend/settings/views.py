from rest_framework import viewsets
from .models import ApplicationSettings
from .serializers import ApplicationSettingsSerializer


class ApplicationSettingsViewSet(viewsets.ModelViewSet):
    queryset = ApplicationSettings.objects.all()
    serializer_class = ApplicationSettingsSerializer
    lookup_field = 'key'
