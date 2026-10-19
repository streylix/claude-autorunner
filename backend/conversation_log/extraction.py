"""Rule-based extraction of "things Ethan asked for" from inbound messages.

Deliberately plain: regex over sentences, no embeddings, no vector DB, no RAG.
At this volume (thousands of rows) a LIKE query beats all of that, and the
result is inspectable and deterministic — the same text always yields the same
ask, which is what makes the extractor idempotent.
"""

import hashlib
import re

# Cues that mark a sentence as a request rather than commentary. Ordered
# loosely by strength; any single match is enough.
ASK_PATTERNS = [
    r"\bcan you\b",
    r"\bcould you\b",
    r"\bwould you\b",
    r"\bplease\b",
    r"\bi want\b",
    r"\bi'?d like\b",
    r"\bi need\b",
    r"\bwe need\b",
    r"\byou need to\b",
    r"\bneeds? to be\b",
    r"\bmake sure\b",
    r"\bdon'?t forget\b",
    r"\bremember to\b",
    r"\bremind me\b",
    r"\bmake it\b",
    r"\bset up\b",
    r"\blet'?s\b",
    r"\bshould (?:be|have|do|get|use|run)\b",
    r"\bgo ahead and\b",
    r"\btodo\b",
    r"^\s*(?:add|fix|build|create|write|change|update|remove|delete|move|rename|"
    r"implement|refactor|check|verify|test|deploy|install|enable|disable|log|"
    r"send|show|start|stop|restart)\b",
]

_COMPILED = [re.compile(p, re.IGNORECASE) for p in ASK_PATTERNS]

# Questions that merely ask for information aren't standing asks.
_NOT_ASK = re.compile(r"^\s*(?:what|why|when|where|who|how|is|are|was|were|did|does|do)\b.*\?\s*$", re.IGNORECASE)

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?;\n])\s+")

MIN_LEN = 8
MAX_LEN = 600


def normalize_text(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()


def dedupe_key(s):
    """Stable fingerprint: casefolded, whitespace- and punctuation-normalized."""
    base = re.sub(r"[^\w\s]", "", normalize_text(s).casefold())
    base = re.sub(r"\s+", " ", base).strip()
    return hashlib.sha256(base.encode("utf-8")).hexdigest()


def is_ask(sentence):
    s = normalize_text(sentence)
    if len(s) < MIN_LEN:
        return False
    if _NOT_ASK.match(s):
        return False
    return any(p.search(s) for p in _COMPILED)


def extract_asks(text):
    """Return the ask-sentences in `text`, normalized and de-duplicated."""
    out = []
    seen = set()
    for raw in _SENTENCE_SPLIT.split(str(text or "")):
        s = normalize_text(raw)
        if not s or not is_ask(s):
            continue
        s = s[:MAX_LEN]
        k = dedupe_key(s)
        if k in seen:
            continue
        seen.add(k)
        out.append(s)
    return out
