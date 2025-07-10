from rest_framework import status
from rest_framework.decorators import api_view
from rest_framework.response import Response
from .models import UserSetting


@api_view(['GET', 'POST'])
def custom_prompt(request):
    """Handle custom prompt setting"""
    if request.method == 'GET':
        try:
            setting = UserSetting.objects.get(key='custom_prompt')
            return Response({'prompt': setting.value})
        except UserSetting.DoesNotExist:
            return Response({'prompt': ''})
    
    elif request.method == 'POST':
        prompt = request.data.get('prompt', '')
        
        setting, created = UserSetting.objects.get_or_create(
            key='custom_prompt',
            defaults={'value': prompt}
        )
        
        if not created:
            setting.value = prompt
            setting.save()
        
        return Response({'prompt': prompt}, status=status.HTTP_200_OK)
