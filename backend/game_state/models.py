from django.db import models


class VibeBlastSave(models.Model):
    """Singleton (pk=1) holding the Vibe Blast easter egg's saved run.

    There is no user model in this backend, so the save is global to the
    install — the same run follows you between the desktop window and a
    Remote Mode browser, which is the point.

    `state` is the game's own JSON snapshot (board, tray, combo, score). It is
    stored opaquely: the game owns that shape and versions it internally, so
    the backend never has to move when the board does.
    """

    best_score = models.IntegerField(default=0)
    state = models.TextField(blank=True, default="")
    updated_at = models.DateTimeField(auto_now=True)

    @classmethod
    def get_solo(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj

    def __str__(self):
        return f"VibeBlastSave(best={self.best_score})"
