"""Second manager: find commitments made in CONVERSATION that were never delivered.

Run inside the autorunner backend container, which owns the conversation database:

    docker exec -i claude-autorunner-backend-1 python manage.py shell < sweep.py

Why this reads the conversation and not the task ledger
-------------------------------------------------------
Everything the manager dropped on 2026-09-17 was agreed in a message and never
became a ledger row. A checker that reads rows inherits that exact blind spot.
This one reads what was SAID: outbound promises ("I will build that to your
phone"), and then looks for evidence that the promise was kept.

Output: one JSON object on stdout between the markers below, so a caller can
parse it without tripping over Django's shell banner.

State lives in conversation_log.OpenAsk, so a reason survives a session roll:
  status=open     - still being raised
  status=done     - delivered; never raised again
  status=dropped  - parked or declined, with the reason in notes
`dedupe_key` is a stable fingerprint of the commitment text, so re-running this
sweep can never create a second row for the same promise.
"""

import hashlib
import json
import os
import re
from datetime import timedelta

from django.utils import timezone

from conversation_log.models import Message, OpenAsk

BEGIN = "<<<SECOND_MANAGER_JSON"
END = "SECOND_MANAGER_JSON>>>"

# How far back a run looks. A promise older than this is assumed handled or
# forgotten on purpose; raising week-old items would make the sweep noise.
DEFAULT_LOOKBACK_HOURS = 24

# --- what counts as a commitment -------------------------------------------
# These match the manager speaking in the first person about work it is about
# to do. Offers ("I can build that whenever you want") are deliberately NOT
# here: the user has not accepted them, so they are not owed anything.
COMMIT_PATTERNS = [
    r"\bI will\b(?! not\b)",
    r"\bI'?ll\b(?! not\b)",
    r"\bI'?m (?:going to|about to)\b",
    r"\bI am (?:going to|about to)\b",
    # Present continuous in the first person covers "I am deleting Apple
    # sign-in" - the Inertia commitment a narrower verb list would have missed.
    r"\bI'?m (?!going\b|about\b|not\b)\w+ing\b",
    r"\bI am (?!going\b|about\b|not\b)\w+ing\b",
    r"\bwill do\b",
    r"\bon it\b",
    r"\bstarting (?:the |that |it )?\w+ now\b",
    r"\bgoes out\b",
    r"\bnext up\b",
    r"\bcomes when\b",
]

# Explicit refusals and hands-off statements are the opposite of a commitment.
NON_COMMIT_PATTERNS = [
    r"\bI will not\b",
    r"\bI won'?t\b",
    r"\bI'?ll not\b",
    r"\bnothing will\b",
    r"\bwill never\b",
]

# Evidence in a LATER outbound message that the thing actually happened.
DONE_PATTERNS = [
    r"\bdone\b", r"\bdelivered\b", r"\bdispatched\b", r"\bshipped\b", r"\bsent\b",
    r"\bfixed\b", r"\bfinished\b", r"\bcomplete[d]?\b", r"\bready now\b", r"\bit'?s live\b",
    r"\bis live\b", r"\bproven\b", r"\bverified\b", r"\bbuilt\b", r"\brotated\b",
    r"\bclosed\b", r"\bup and running\b", r"\bworks now\b", r"\bis fixed\b", r"\bnow you can\b",
]

# The manager saying, in its own words, that it never did the thing. This is
# the strongest possible signal and must never be read as completion.
ADMISSION_PATTERNS = [
    r"\bnever dispatched\b", r"\bnever started\b", r"\bhas not started\b", r"\bhasn'?t started\b",
    r"\bnever came back to it\b", r"\bI dropped\b", r"\bI owe you\b", r"\bnot started anything\b",
    r"\bstill sitting\b", r"\bnever turned into\b",
]

# The user parking or declining something, in a reply.
PARK_PATTERNS = [
    r"\bhold on\b", r"\bhands off\b", r"\bdon'?t\b", r"\bdo not\b", r"\bstop\b",
    r"\bnot now\b", r"\blater\b", r"\bleave it\b", r"\bwait\b", r"\bno need\b",
    r"\bnevermind\b", r"\bnever mind\b", r"\bforget it\b", r"\bcancel\b",
]

# Things Ethan asked for, in his words. This is deliberately WIDER than
# conversation_log.extraction's list, which has no "ensure" and so missed
# "ensure placeholder key is diff across all projects" entirely - the ask behind
# one of the three failures this sweep exists to catch.
ASK_PATTERNS = [
    r"\bensure\b", r"\bmake sure\b", r"\bcan you\b", r"\bcould you\b", r"\bplease\b",
    r"\bi want\b", r"\bi'?d like\b", r"\bi need\b", r"\bwe need\b", r"\byou need to\b",
    r"\bdon'?t forget\b", r"\bremind me\b", r"\bmake it\b", r"\bset up\b", r"\blet'?s\b",
    r"\bgo ahead and\b", r"\bshould (?:be|have|do|get|use|run|show)\b",
    r"^\s*(?:add|fix|build|create|write|change|update|remove|delete|move|rename|"
    r"implement|refactor|check|verify|test|deploy|install|enable|disable|log|send|"
    r"show|start|stop|restart|push|pull|connect|give|get|make|keep)\b",
]

# Bare questions are requests for information, not standing work.
_NOT_ASK = re.compile(
    r"^\s*(?:what|why|when|where|who|how|is|are|was|were|did|does|do|can|could|should)\b.*\?\s*$",
    re.IGNORECASE,
)

# A promise the user still has to trigger ("say the word and it goes out") is
# not work the manager owes; it is work waiting on Ethan. Raising those as
# broken promises would be wrong, so they are reported in their own bucket.
CONDITIONAL_PATTERNS = [
    # NOT "unless you": "starting the backend now unless you want something
    # else first" is a commitment being acted on, not one waiting on Ethan.
    r"\bsay the word\b", r"\bsay go\b", r"\btell me when\b",
    r"\bif you want\b", r"\bwhenever you want\b", r"\bwant me to\b",
    r"\bjust say\b", r"\blet me know\b", r"\bif you'?d (?:rather|like)\b",
]

# Statements of policy or restraint ("going forward I will treat that tree as
# off limits"). Nothing is owed; there is no deliverable to chase.
POLICY_PATTERNS = [
    r"\bgoing forward\b", r"\bI will treat\b", r"\bI will leave\b", r"\bI will keep\b",
    r"\bI'?m leaving\b", r"\bI am leaving\b", r"\bleaving it until\b", r"\bhands off\b",
    r"\bI will never\b", r"\bfrom now on\b", r"\bI will stay\b", r"\bI will respect\b",
]

STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "so", "that", "this", "these", "those", "it",
    "its", "is", "are", "was", "were", "be", "been", "being", "to", "of", "in", "on",
    "for", "with", "at", "by", "from", "as", "into", "about", "your", "you", "yours",
    "i", "me", "my", "mine", "we", "our", "will", "would", "can", "could", "should",
    "now", "then", "not", "no", "yes", "do", "does", "did", "done", "have", "has",
    "had", "get", "got", "one", "two", "out", "up", "down", "off", "over", "than",
    "them", "they", "there", "here", "what", "when", "which", "who", "how", "why",
    "if", "any", "all", "some", "more", "most", "just", "only", "also", "rather",
    "first", "next", "thing", "things", "something", "anything", "going", "make",
    "made", "back", "still", "again", "same", "own", "day", "today", "minutes",
}

_CONDITIONAL = [re.compile(p, re.I) for p in CONDITIONAL_PATTERNS]
_POLICY = [re.compile(p, re.I) for p in POLICY_PATTERNS]
_COMMIT = [re.compile(p, re.I) for p in COMMIT_PATTERNS]
_NON_COMMIT = [re.compile(p, re.I) for p in NON_COMMIT_PATTERNS]
_DONE = [re.compile(p, re.I) for p in DONE_PATTERNS]
_ADMISSION = [re.compile(p, re.I) for p in ADMISSION_PATTERNS]
_PARK = [re.compile(p, re.I) for p in PARK_PATTERNS]
_ASK = [re.compile(p, re.I) for p in ASK_PATTERNS]

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?;\n])\s+")
# Outbound messages open with a markdown heading line ("### 🏋️ Log today's
# workout — Day C lift"), which is a routing label, not something said. It must
# come off BEFORE whitespace is collapsed, or it merges into the first sentence.
_HEADER = re.compile(r"\A\s*#+[^\n]*\n+")

MIN_LEN = 12
MAX_LEN = 400


def norm(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()


def strip_header(s):
    # Header first, THEN collapse whitespace: the heading is only recognisable
    # while its trailing newline still exists.
    return norm(_HEADER.sub("", str(s or "")))


def dedupe_key(s):
    base = re.sub(r"[^\w\s]", "", norm(s).casefold())
    return "sm:" + hashlib.sha256(re.sub(r"\s+", " ", base).strip().encode()).hexdigest()[:58]


def tokens(s):
    """Content words, crudely singularised so "keys" matches "key"."""
    out = set()
    for w in re.findall(r"[a-z0-9]+", norm(s).casefold()):
        if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]
        if len(w) > 2 and w not in STOPWORDS:
            out.add(w)
    return out


def any_match(pats, s):
    return any(p.search(s) for p in pats)


def commitment_sentences(text):
    """Sentences in one outbound message that promise future work."""
    out = []
    for raw in _SENTENCE_SPLIT.split(strip_header(text)):
        s = norm(raw)
        if not (MIN_LEN <= len(s)):
            continue
        s = s[:MAX_LEN]
        if any_match(_NON_COMMIT, s):
            continue
        if any_match(_COMMIT, s):
            out.append(s)
    return out


def ask_sentences(text):
    """Sentences in one inbound message that ask for work."""
    out = []
    for raw in _SENTENCE_SPLIT.split(norm(text)):
        s = norm(raw)[:MAX_LEN]
        if len(s) < MIN_LEN or _NOT_ASK.match(s):
            continue
        if any_match(_ASK, s):
            out.append(s)
    return out


def candidates(messages):
    """Every commitment and every ask in the window, in time order."""
    for m in messages:
        if m.direction == "outbound":
            for s in commitment_sentences(m.text):
                yield ("commitment", s, m)
        else:
            for s in ask_sentences(m.text):
                yield ("ask", s, m)


def sweep(lookback_hours=DEFAULT_LOOKBACK_HOURS, overlap=2, now=None):
    now = now or timezone.now()
    since = now - timedelta(hours=lookback_hours)
    msgs = list(Message.objects
                .filter(created_at__gte=since, created_at__lte=now)
                .order_by("created_at", "id"))
    real = [m for m in msgs if not (isinstance(m.meta, dict) and m.meta.get("synthetic"))]

    items = []
    for kind, sentence, m in candidates(real):
        later = [x for x in real if x.created_at > m.created_at]
        ctokens = tokens(sentence)
        if len(ctokens) < overlap:
            continue
        # Matching stays on the commitment's OWN words. Widening it to the
        # whole message plus the ask that prompted it was tried and reverted:
        # on a busy day three common words co-occur everywhere, and it
        # silently marked the dropped Inertia promise "delivered" by matching
        # a message about Mac ports. A wrongly matched completion hides a
        # dropped promise, which is the expensive mistake here.

        admitted = False
        delivered = None
        parked = None
        for x in later:
            xt = strip_header(x.text)
            shared = ctokens & tokens(xt)
            if len(shared) < overlap:
                continue
            if x.direction == "outbound":
                # An admission of not doing it outranks any later "done".
                if any_match(_ADMISSION, xt):
                    admitted = True
                    delivered = None
                    continue
                # An ASK is settled by the manager engaging with it on subject:
                # answers rarely contain the word "done" ("here it is", "gone",
                # "straight answer: there were none"). A COMMITMENT is not - the
                # manager talking about a promise is exactly what it did all day
                # with the ones it dropped, so that still needs done-words.
                if not admitted and (any_match(_DONE, xt) or kind == "ask"):
                    delivered = x
            elif (x.direction == "inbound" and parked is None
                  and any_match(_PARK, xt)
                  and (x.created_at - m.created_at) <= timedelta(minutes=60)):
                # Only a prompt reply parks something. Without the window,
                # one later "wait..." from Ethan about an unrelated subject
                # marked every open promise of the day parked.
                parked = x

        if delivered is not None:
            state = "delivered"
        elif parked is not None:
            state = "parked_by_user"
        elif kind == "commitment" and any_match(_POLICY, sentence):
            state = "policy"
        elif kind == "commitment" and any_match(_CONDITIONAL, sentence):
            state = "awaiting_user"
        else:
            state = "outstanding"

        items.append({
        "kind": kind,
            "commitment": sentence,
            "source_message_id": m.id,
            "source_timestamp": m.created_at.isoformat(),
            "source_quote": strip_header(m.text)[:400],
            "state": state,
            "admission": admitted,
            "evidence_message_id": (delivered or parked).id if (delivered or parked) else None,
            "evidence_quote": strip_header((delivered or parked).text)[:200] if (delivered or parked) else "",
            "dedupe_key": dedupe_key(sentence),
        })

    # Inbound asks the existing extractor already tracks, still open and recent.
    asks = []
    for a in OpenAsk.objects.filter(status="open", created_at__gte=since).select_related("source_message"):
        if a.dedupe_key.startswith("sm:"):
            continue
        asks.append({
            "text": a.text,
            "ask_id": a.id,
            "source_message_id": a.source_message_id,
            "source_timestamp": a.source_message.created_at.isoformat() if a.source_message else None,
        })
    return items, asks


def persist(items):
    """Store commitments as OpenAsk rows and apply any reason already recorded.

    A row whose status is done/dropped is never raised again - that is the
    suppression mechanism, and it lives in the database, so it survives a
    session roll.
    """
    raise_list, suppressed = [], []
    for it in items:
        row, created = OpenAsk.objects.get_or_create(
            dedupe_key=it["dedupe_key"],
            defaults={
                "text": it["commitment"],
                "source_message_id": it["source_message_id"],
                "notes": "second-manager: commitment made in conversation",
            },
        )
        it["ask_id"] = row.id
        it["row_status"] = row.status
        it["row_notes"] = row.notes
        it["row_created"] = created

        if row.status != "open":
            suppressed.append(it)
            continue

        # Waiting on Ethan is not a broken promise. The row stays open so it is
        # visible, but the manager is not nagged about work it cannot start.
        if it["state"] == "awaiting_user":
            suppressed.append(it)
            continue

        # Parked in the reply, or a statement of policy with no deliverable:
        # recorded as dropped WITH the reason, so it is never raised again.
        if it["state"] in ("parked_by_user", "policy"):
            reason = ("parked by Ethan in message %s" % it["evidence_message_id"]
                      if it["state"] == "parked_by_user"
                      else "statement of policy, nothing to deliver")
            row.status = "dropped"
            row.resolved_at = timezone.now()
            row.notes = (row.notes + "\nsecond-manager: " + reason).strip()
            row.save(update_fields=["status", "resolved_at", "notes"])
            it["row_status"] = "dropped"
            suppressed.append(it)
            continue

        if it["state"] == "delivered":
            # Evidence in the conversation itself, recorded so the next run is
            # cheap and the reason is auditable.
            row.status = "done"
            row.resolved_at = timezone.now()
            row.notes = (row.notes + f"\nsecond-manager: delivered, see message {it['evidence_message_id']}").strip()
            row.save(update_fields=["status", "resolved_at", "notes"])
            it["row_status"] = "done"
            suppressed.append(it)
            continue
        raise_list.append(it)
    return raise_list, suppressed


def main(argv):
    # Options arrive in SM_ARGS, not argv: this file is executed by piping it
    # into `manage.py shell`, which owns sys.argv.
    lookback = DEFAULT_LOOKBACK_HOURS
    write = False
    until = None
    for arg in argv:
        if arg.startswith("--hours="):
            lookback = float(arg.split("=", 1)[1])
        elif arg == "--write":
            write = True
        elif arg.startswith("--until="):
            # Replay: pretend it is this moment. Nothing after it exists, which
            # is how a past run can be reproduced exactly.
            from django.utils.dateparse import parse_datetime
            until = parse_datetime(arg.split("=", 1)[1])

    items, asks = sweep(lookback_hours=lookback, now=until)
    if write:
        raise_list, suppressed = persist(items)
    else:
        # Read-only, but still honest: existing rows are read so a reason
        # already recorded still suppresses, and each item still carries the id
        # needed to record one.
        rows = {r.dedupe_key: r for r in
                OpenAsk.objects.filter(dedupe_key__in=[i["dedupe_key"] for i in items])}
        raise_list, suppressed = [], []
        for it in items:
            row = rows.get(it["dedupe_key"])
            it["ask_id"] = row.id if row else None
            it["row_status"] = row.status if row else "open"
            it["row_notes"] = row.notes if row else ""
            if it["state"] == "outstanding" and it["row_status"] == "open":
                raise_list.append(it)
            else:
                suppressed.append(it)

    print(BEGIN)
    print(json.dumps({
        "generated_at": timezone.now().isoformat(),
        "lookback_hours": lookback,
        "wrote_rows": write,
        "raise": raise_list,
        "suppressed": suppressed,
        "open_inbound_asks": asks,
        "counts": {
            "commitments_found": len(items),
            "to_raise": len(raise_list),
            "suppressed": len(suppressed),
            "open_inbound_asks": len(asks),
        },
    }, indent=1))
    print(END)


main(os.environ.get("SM_ARGS", "").split())
