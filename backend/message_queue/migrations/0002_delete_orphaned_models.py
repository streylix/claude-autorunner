"""Drop the orphaned QueuedMessage / MessageHistory tables.

The message_queue app is now a pure pass-through (the frontend queue is the
single source of truth), so models.py is empty. Migration 0001 still created
these two tables, leaving them orphaned in both the existing sqlite database
and any fresh Postgres database. This migration deletes them so the migration
state matches the (empty) models, keeping `makemigrations --check` clean.
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("message_queue", "0001_initial"),
    ]

    operations = [
        migrations.DeleteModel(name="MessageHistory"),
        migrations.DeleteModel(name="QueuedMessage"),
    ]
