# Generated by Django 4.2.7 on 2025-07-10 14:03

from django.db import migrations, models
import uuid


class Migration(migrations.Migration):

    dependencies = [
        ("terminal", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="ApplicationStatistics",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("session_id", models.CharField(max_length=255, unique=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("current_directory", models.CharField(default="~", max_length=500)),
                ("injection_count", models.IntegerField(default=0)),
                ("keyword_count", models.IntegerField(default=0)),
                ("plan_count", models.IntegerField(default=0)),
                ("terminal_count", models.IntegerField(default=1)),
                ("active_terminal_id", models.IntegerField(default=1)),
                ("terminal_id_counter", models.IntegerField(default=1)),
            ],
            options={
                "ordering": ["-updated_at"],
            },
        ),
        migrations.AddField(
            model_name="terminalsession",
            name="color",
            field=models.CharField(default="#007acc", max_length=7),
        ),
        migrations.AddField(
            model_name="terminalsession",
            name="frontend_terminal_id",
            field=models.IntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="terminalsession",
            name="position_index",
            field=models.IntegerField(default=0),
        ),
    ]
