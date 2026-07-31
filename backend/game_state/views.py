from rest_framework.decorators import api_view
from rest_framework.response import Response

from .models import VibeBlastSave

# A board snapshot is a few hundred bytes; this is a sanity bound, not a limit
# anyone should ever reach.
MAX_STATE_CHARS = 65536


@api_view(["GET", "PUT"])
def vibe_blast(request):
    """Get/set the Vibe Blast saved run and its all-time best score.

    PUT accepts either field on its own, so the client can push a new best
    without also having to hand back the board.
    """
    save = VibeBlastSave.get_solo()

    if request.method == "PUT":
        data = request.data or {}
        changed = []

        if "best_score" in data:
            try:
                best = int(data["best_score"])
            except (TypeError, ValueError):
                return Response(
                    {"success": False, "error": "best_score must be an integer"},
                    status=400,
                )
            if best < 0:
                return Response(
                    {"success": False, "error": "best_score must not be negative"},
                    status=400,
                )
            # The best score only ever goes up. Two renderers can be attached at
            # once (a desktop window and a Remote Mode browser), and a plain
            # last-write-wins would let the one with the older number erase a
            # record set in the other.
            if best > save.best_score:
                save.best_score = best
                changed.append("best_score")

        if "state" in data:
            state = data["state"]
            if state is None:
                state = ""
            if not isinstance(state, str):
                return Response(
                    {"success": False, "error": "state must be a string"}, status=400
                )
            if len(state) > MAX_STATE_CHARS:
                return Response(
                    {"success": False, "error": "state too large"}, status=400
                )
            save.state = state
            changed.append("state")

        if changed:
            save.save(update_fields=changed + ["updated_at"])

    return Response(
        {
            "best_score": save.best_score,
            "state": save.state,
            "updated_at": save.updated_at.isoformat(),
        }
    )


@api_view(["GET"])
def health(request):
    return Response({"status": "ok"})
