from django.db import models
from django.utils import timezone


class PricingData(models.Model):
    """Store pricing data from ccusage command executions"""
    session_id = models.CharField(max_length=255, help_text="Session identifier")
    execution_timestamp = models.DateTimeField(default=timezone.now, help_text="When the ccusage command was executed")
    raw_output = models.TextField(help_text="Raw output from ccusage command")
    parsed_data = models.JSONField(default=dict, help_text="Parsed pricing data")
    total_cost = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True, help_text="Total cost in USD")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-execution_timestamp']
        db_table = 'pricing_data'

    def __str__(self):
        return f"Pricing data for session {self.session_id} at {self.execution_timestamp}"


class PricingCache(models.Model):
    """Cache pricing data to avoid frequent command executions"""
    cache_key = models.CharField(max_length=255, unique=True, help_text="Cache key for pricing data")
    data = models.JSONField(help_text="Cached pricing data")
    expires_at = models.DateTimeField(help_text="Cache expiration time")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'pricing_cache'

    def __str__(self):
        return f"Pricing cache {self.cache_key}"

    @property
    def is_expired(self):
        return timezone.now() > self.expires_at