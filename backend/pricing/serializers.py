from rest_framework import serializers
from .models import PricingData, PricingCache


class PricingDataSerializer(serializers.ModelSerializer):
    class Meta:
        model = PricingData
        fields = ['id', 'session_id', 'execution_timestamp', 'parsed_data', 'total_cost', 'created_at']
        read_only_fields = ['id', 'created_at']


class PricingCacheSerializer(serializers.ModelSerializer):
    is_expired = serializers.ReadOnlyField()
    
    class Meta:
        model = PricingCache
        fields = ['cache_key', 'data', 'expires_at', 'is_expired', 'created_at']
        read_only_fields = ['created_at']