from django.core.management.commands.runserver import Command as RunServerCommand


class Command(RunServerCommand):
    default_port = '8001'
    
    def add_arguments(self, parser):
        super().add_arguments(parser)
        parser.set_defaults(addrport='127.0.0.1:8001')