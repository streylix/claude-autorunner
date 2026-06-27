# Python voice-receive fallback (NOT the default — read first)

The bridge uses the **Node** path (`@discordjs/voice@0.19.2`), which is the only
route where DAVE voice-**receive** is fixed in a published release (PR #11449).
This folder exists only as a documented escape hatch if Discord regresses the
Node receive path.

## State of the Python path (verified June 2026)

- `discord.py` **2.7.1** is DAVE-ready for connect/send (DAVE added in 2.7.0).
  You MUST be on ≥2.7.1; older versions are rejected by Discord (close `4017`).
- `discord-ext-voice-recv` (latest `0.5.2a179`, repo stale since June 2025) does
  **NOT** decrypt DAVE. It treats still-encrypted payloads as Opus →
  `OpusError: corrupted stream` / garbled audio.
  - Open issue: <https://github.com/imayhaveborkedit/discord-ext-voice-recv/issues/53>
  - **Unmerged** fix: <https://github.com/imayhaveborkedit/discord-ext-voice-recv/pull/54>
    ("Added support for DAVE decryption in opus.py").

## So this is NOT a drop-in

To make Python receive work today you would have to:
1. `pip install discord.py==2.7.1 'discord-ext-voice-recv'`
2. Manually apply PR #54 to the installed `voice_recv/opus.py` (run the DAVE
   session decrypt before Opus→PCM), or install the author's fork/branch if one
   has merged it by the time you read this.
3. Reuse the same seams the Node bridge uses:
   - POST captured WAV to `http://localhost:8123/api/voice/transcribe/`
     (multipart field `audio_file`).
   - POST the framed memo to `http://127.0.0.1:$CCBOT_PORT/terminal/keys`
     with header `X-CCBOT-Token: $CCBOT_TOKEN` and body
     `{"terminalId":999,"keys":["<FRAMED_TEXT>","enter"]}`, where `<FRAMED_TEXT>`
     starts with:
     `🎙️ Voice memo from the user (spoken aloud, auto-transcribed — phrasing may be imperfect):`
     then a newline and the transcript in quotes.

Only pursue this if the Node receiver regresses under a future DAVE/MLS change.
For now, prefer the Node path and report any receive failure so we can re-check
upstream first.
