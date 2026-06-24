"""
Curated catalog of Kokoro-82M voices exposed by the TTS API.

Kokoro voice names encode language + gender in the first two characters:
  - first char  → language pipeline code ("a" = American English,
    "b" = British English). This is what KPipeline(lang_code=...) needs.
  - second char → "f" (female) / "m" (male).

We restrict the catalog to English (a/b) so synthesis only depends on the
espeak-ng + misaki[en] stack the Dockerfile installs. Quality grades come from
hexgrad's published voice grades; "heart" is the flagship voice.
"""

VOICES = [
    # American English — female
    {"id": "af_heart", "label": "Heart (US ♀)", "lang": "a", "gender": "female", "grade": "A"},
    {"id": "af_bella", "label": "Bella (US ♀)", "lang": "a", "gender": "female", "grade": "A-"},
    {"id": "af_nicole", "label": "Nicole (US ♀)", "lang": "a", "gender": "female", "grade": "B-"},
    {"id": "af_aoede", "label": "Aoede (US ♀)", "lang": "a", "gender": "female", "grade": "C+"},
    {"id": "af_kore", "label": "Kore (US ♀)", "lang": "a", "gender": "female", "grade": "C+"},
    {"id": "af_sarah", "label": "Sarah (US ♀)", "lang": "a", "gender": "female", "grade": "C+"},
    {"id": "af_nova", "label": "Nova (US ♀)", "lang": "a", "gender": "female", "grade": "C"},
    {"id": "af_sky", "label": "Sky (US ♀)", "lang": "a", "gender": "female", "grade": "C-"},
    # American English — male
    {"id": "am_michael", "label": "Michael (US ♂)", "lang": "a", "gender": "male", "grade": "C+"},
    {"id": "am_fenrir", "label": "Fenrir (US ♂)", "lang": "a", "gender": "male", "grade": "C+"},
    {"id": "am_puck", "label": "Puck (US ♂)", "lang": "a", "gender": "male", "grade": "C+"},
    {"id": "am_echo", "label": "Echo (US ♂)", "lang": "a", "gender": "male", "grade": "D"},
    {"id": "am_eric", "label": "Eric (US ♂)", "lang": "a", "gender": "male", "grade": "D"},
    {"id": "am_liam", "label": "Liam (US ♂)", "lang": "a", "gender": "male", "grade": "D"},
    {"id": "am_onyx", "label": "Onyx (US ♂)", "lang": "a", "gender": "male", "grade": "D"},
    # British English — female
    {"id": "bf_emma", "label": "Emma (UK ♀)", "lang": "b", "gender": "female", "grade": "B-"},
    {"id": "bf_isabella", "label": "Isabella (UK ♀)", "lang": "b", "gender": "female", "grade": "C"},
    {"id": "bf_alice", "label": "Alice (UK ♀)", "lang": "b", "gender": "female", "grade": "D"},
    {"id": "bf_lily", "label": "Lily (UK ♀)", "lang": "b", "gender": "female", "grade": "D"},
    # British English — male
    {"id": "bm_george", "label": "George (UK ♂)", "lang": "b", "gender": "male", "grade": "C"},
    {"id": "bm_fable", "label": "Fable (UK ♂)", "lang": "b", "gender": "male", "grade": "C"},
    {"id": "bm_lewis", "label": "Lewis (UK ♂)", "lang": "b", "gender": "male", "grade": "D+"},
    {"id": "bm_daniel", "label": "Daniel (UK ♂)", "lang": "b", "gender": "male", "grade": "D"},
]

DEFAULT_VOICE = "af_heart"

_VOICE_IDS = {v["id"] for v in VOICES}


def is_valid_voice(voice_id: str) -> bool:
    return voice_id in _VOICE_IDS


def lang_code_for(voice_id: str) -> str:
    """The KPipeline lang_code is the first char of the voice id (a/b/...)."""
    return voice_id[0] if voice_id else "a"
