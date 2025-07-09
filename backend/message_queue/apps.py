from django.apps import AppConfig


class MessageQueueConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "message_queue"

    def ready(self):
        import message_queue.signals
