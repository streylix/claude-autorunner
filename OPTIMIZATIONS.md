# Fleet-management optimizations

Plain-English log of improvements to the Auto-Injector control interface, driven by
the manager (terminal 999) as product owner. Each entry is one focused change on the
project's current git branch.

---

## 2026-06-27 — Audit fixes: two HIGH-severity autorunner bugs

From the all-projects bug-swarm audit; user approved fixing the **highs only**
(mediums/lows deferred).

**1. Device screenshots corrupted by UTF-8 decoding (`src/adb/adb-manager.js`).**
`executeCommand()` accumulated stdout with `output += data.toString()` — a lossy
UTF-8 decode of every chunk (invalid byte sequences collapse to U+FFFD). For text
commands that's fine, but `takeScreenshot()` then rebuilt the PNG via
`Buffer.from(result.output, 'binary')`, and the bytes were already destroyed, so
the screenshot was garbage. Fix: accumulate raw `Buffer` chunks
(`stdoutChunks.push(...)`) and `Buffer.concat` them; resolve with both a string
`output` (backward-compatible for text callers) and a raw `outputBuffer`.
`takeScreenshot` now uses `result.outputBuffer`. Added an injectable `this.spawn`
seam so the binary path is unit-testable.

**2. Fallback usage-limit detection was dead code
(`src/features/UsageLimitManager.js`).** `isDuplicateDetection(resetTime)` has a
side effect — it records the minute-precision reset-time key and returns false
only the first time. `detectUsageLimit()` (the raw `terminal:data` fallback)
called it at line 114 (recording the key), then called `onUsageLimitDetected()`,
which called `isDuplicateDetection()` *again* — now the key existed, so it
reported a duplicate and bailed before `beginWaiting()`. The fallback never once
engaged the gate. Fix: drop the redundant pre-check in `detectUsageLimit()` and
let `onUsageLimitDetected()` be the single dedup/cooldown authority (mirrors the
primary hook path). Genuine duplicates are still deduped (verified).

**Verified (no deploy — Electron NOT restarted, manager 999 left alive).** New
`src/adb/adb-manager.test.js` (fake spawn streaming non-UTF-8 PNG bytes: raw
bytes survive intact; the old string path is shown lossy) and
`src/features/usage-limit-fallback.test.js` (fallback now fires; repeats still
de-dupe). Both confirmed RED with the fixes stashed, GREEN with them applied;
full feature + adb suites green; `node --check` clean. Deploys on the next
deliberate Electron restart. Mediums/lows from the audit left for later.

---

## 2026-06-27 — Spoken notifications: echo gate + guaranteed completion

**Follow-up to the talk-over fix below.** Two remaining gaps: (1) the spoken
notification's own audio, picked up by the mic, tripped the always-on RMS VAD
(`WakeWordManager._updateSpeechSignal`) and paused the readout — self-inflicted
interruptions; (2) under *truly continuous* talking a held clip never received a
`speech:idle`, so it could stall indefinitely, and the old loop-guard *dropped*
the message at the cap rather than finishing it. The user's priority: a
notification must **always complete** and **never loop or stall**, whether the
trigger is the user talking or echo — lean toward letting it play through.

**Echo gate (`WakeWordManager.js`).** While a notification is actually playing
(plus a short `TTS_ECHO_TAIL_MS = 400` tail), the VAD raises its gate from the
sensitive floor (`RMS_VOICE_THRESHOLD = 0.010`) to `RMS_BARGE_IN_THRESHOLD =
0.030`, so only sound clearly louder than the speaker echo — a real, close-mic
barge-in — counts as "user speaking". `NotificationManager` now emits
`tts:playback {active}` on every start/resume/pause/end; WakeWordManager tracks
it (`_setTtsPlayback` / `_inTtsEchoWindow`). Outside playback the floor is
unchanged, so normal speech sensitivity and wake-word capture are untouched.
`RMS_BARGE_IN_THRESHOLD` is the tunable knob (lower = easier to interrupt the
TTS and more echo false-positives; higher = harder to barge in).

**Guaranteed completion (`NotificationManager.js`).** A barge-in still gets a
brief resume-in-place hold, but completion is now bounded two ways and the
backstop **plays through** instead of dropping: (a) a held clip that the user
never lets clear is force-resumed by a `MAX_HELD_MS = 4000` watchdog and flagged
play-through; (b) a clip interrupted `MAX_HOLDS_PER_MESSAGE = 3` times is flagged
play-through immediately. A play-through clip is resumed in place and **never
paused again** (`_playThrough` set), so continuous talking can neither loop nor
stall it — it finishes. The cap path no longer marks-played-and-drops.

**Real barge-in preserved.** A genuinely loud interruption above the gate still
pauses and resumes-in-place; only echo (and very soft over-talking) is ignored.

**Verified (no deploy — Electron NOT restarted, manager 999 left alive).** New
`src/features/tts-echo-gate.test.js` wires both managers on one bus: TTS echo
during playback does NOT hold; a loud barge-in still holds then resumes in place;
non-TTS sensitivity is unchanged; the gate persists for the tail. Updated
`NotificationManager.test.js`: repeated interruptions play through to completion
(not dropped, not looped, resumed in place), and a watchdog force-resumes a clip
the user keeps talking over. All feature suites green (NotificationManager 4,
tts-echo-gate 4, PromptWatchManager 11, others); `node --check` clean on both
modules and `renderer.js`. Deploys on the next deliberate Electron restart;
`RMS_BARGE_IN_THRESHOLD` can be tuned then if echo is louder/quieter in practice.

---

## 2026-06-27 — Spoken notifications: stop the talk-over replay loop

**Problem (live user report).** Talking — or background noise — while a TTS
notification was being read aloud interrupted it, went silent, and **reset the
message back to the start**. With continuous talking/noise it looped the *same*
message forever and never finished.

**Root cause (renderer, `src/features/NotificationManager.js`).** The "hold while
talking" feature handled a mid-readout interruption by pausing the clip and
`playQueue.unshift(n)`-ing it back to the front, then — on the trailing-silence
release — restarting it via `_startAudio`, which reassigns `audio.src` and so
**plays from position 0**. There was no resume offset and no cap on restarts, so
each `speech:active`/`speech:idle` cycle replayed the whole clip (chime included)
from the top. The continuous-noise driver is acoustic feedback: the spoken
notification itself is picked up by the mic, trips the always-on RMS VAD
(`WakeWordManager._updateSpeechSignal`), and re-fires the hold — an endless
restart-from-0 loop. The Django backend and the Discord bridge were ruled out:
the backend serves each row once (client advances a monotonic `lastSeenId`
cursor), and the bridge in its default system-audio mode just relays the
desktop's own playback verbatim — so the loop was entirely the renderer's.

**Fix.** An interrupted clip now **resumes from where it paused instead of
restarting**: on hold we only `pause()` (the audio element keeps its `src` and
`currentTime`) and track it in a separate `_held` slot — never re-queued — so
`_drainQueue` resumes it with a bare `audio.play()` (no chime, no `src` reload,
no rewind). A loop guard (`MAX_HOLDS_PER_MESSAGE = 3`) caps interruptions per
clip; past the cap we stop deferring, mark it played server-side, and move on —
so noise/echo can never restart-and-replay forever. `_enqueuePlay` now de-dupes
against the playing/held/queued ids so the same notification can't be queued
twice. Explicit user replays abandon any held clip (shared audio element).

**Verified (no deploy — Electron NOT restarted, manager 999 left alive).** New
unit tests `src/features/NotificationManager.test.js` (fake `Audio`/`fetch`/DOM):
a mid-playback interruption resumes from the same position without reloading
`src`; five back-to-back interruptions do **not** loop — the clip is marked
played and dropped after the cap; duplicate enqueue is ignored. RED first
(3 fail on the old code), then GREEN (3/3 pass); `node --check` clean on the
module and `renderer.js`.

**Not changed (deliberate).** The Discord bridge's separate auto-reply→forward
content feedback loop (speech re-triggering *new* manager replies) is a distinct
issue, out of scope for this symptom. Residual follow-up: the always-on VAD has
no echo/output gating, so the TTS output can still trip a hold or two before a
clip completes — an acoustic-echo-cancellation / "ignore mic while TTS plays"
pass would smooth that, but the loop guard already bounds it.

---

## 2026-06-27 — Discord bridge: reliable wake→command pickup + wake sound on detection

**Problems (live user testing).** Two failures in the Discord voice bridge
(`discord-bridge/src/voiceReceive.js`):

1. **Speech after the wake word often didn't come through.** Commands the user
   spoke after saying "sean" frequently never reached the manager.
2. **The wake/"blade" sound didn't fire when the user went silent after the wake
   word** — it appeared gated on actually capturing a command.

**Root cause (measured, not guessed).** The bridge gates every utterance through
the cheap CPU **Vosk** endpoint (`/api/voice/wake-check/`) to avoid running GPU
Whisper on idle chatter, and only matches the wake word against that transcript.
Synthesizing test speech and POSTing the exact 48 kHz-stereo WAV the bridge
produces to both endpoints showed Vosk **mishears the short wake name**:

| spoken | Vosk (gate) | Whisper |
|--------|-------------|---------|
| "sean" | `sean` ✓ (fragile on mic) | `Sean` ✓ |
| "sean what is the status" | **`sure what is the status`** ✗ | `Sean, what is the status?` ✓ |

`soundex("sure")=S600 ≠ soundex("sean")=S500` and `lev=2 > 1`, so the wake
spotter **rejected the whole "sean <command>" utterance** ("no wake word —
ignoring"). Whisper heard it perfectly. Two consequences: the inline wake+command
in one breath was dropped (Bug 1), and because detection failed there was no
`onWakeAck` (Bug 2). A second, independent Bug-1 cause: the *armed follow-up*
path ran the command through Vosk first and `return`ed on empty/garbled Vosk
output — discarding a valid command **before Whisper ever saw it**.

**Fix.** Restructured `_processSerial` around "am I expecting a command?":

- **Expecting a command** (armed after a lone wake word, or inside the post-reply
  auto-reply window): the utterance *is* the command → transcribe **straight to
  Whisper** (Vosk fallback only if Whisper is empty). Never gate a command
  through Vosk. The arm/window is consumed only on a real forward; an empty
  transcript keeps listening instead of dropping it.
- **Detecting** (not expecting a command): cheap Vosk gate first (fast path,
  no GPU when it clearly contains the wake word); if it **doesn't** match,
  **escalate short utterances (≤ `wakeEscalateMaxMs`, default 12 s) to Whisper**
  to confirm the wake word before giving up — this recovers the
  Vosk-garbled "sean <command>". The wake-ack sound fires the **instant** the
  wake word is detected, before/independent of any follow-up command (silence
  after the wake word still chimes).
- Timing for breathing room: command end-of-speech silence 1.5 s → **2.0 s**,
  armed-follow-up window 8 s → **10 s**, plus a `maxUtteranceMs` (30 s) capture
  cap so a non-stop talker still gets transcribed.

New/changed config (`discord-bridge/config.js`): `wakeEscalateMaxMs` (default
12000; 0 = pure GPU-saving, no escalation), `maxUtteranceMs` (30000),
`commandSilenceMs` 1500→2000, `wakeFollowupMs` 8000→10000, `minUtteranceMs`
250→200.

**GPU note.** Escalation runs Whisper on short utterances the Vosk gate didn't
match — in a manager-control channel (mostly commands, Discord only fires capture
on real voice activity) this is a few extra short clips, the right trade for not
dropping commands. Set `WAKE_ESCALATE_MAX_MS=0` to revert to Vosk-only gating.

**Verified.** A harness drove the **real** `VoiceReceiver._processSerial` against
the **live backend** with synthesized WAVs (lone wake, inline wake+command,
two-step armed command, non-wake chatter): **14/14** assertions passed —
including the escalation log "wake word recovered by Whisper escalation (Vosk
missed it)" on the inline case, the chime firing on a lone wake with silence
after, and non-wake chatter still ignored (no false trigger). `npm run check`
clean. Pending live confirmation by the user before commit.

### Follow-up (same day) — reliable wake DETECTION + audible/logged wake sound

**Live retest.** The forwarding fix worked (command reached terminal 999, and
Whisper escalation recovered the wake word). But detection was still flaky: the
speech engines kept rendering a lone "sean" as near-homophones the matcher then
**rejected** — observed live: `don, john, jon, on, dawn, dawn stone, done, dumb`.
And the wake/"blade" sound never fired on silence-after-wake (because detection
failed, `onWakeAck` was never reached — and `playSound` logged nothing, so it was
invisible).

**Why soundex alone missed them.** "sean" is /ʃɔːn/. The mishearings keep the
-awn/-on rime but change the onset (SH→D/J/G…), and classic soundex keys off the
first letter, so it scatters them (`S500` vs `J500` vs `D500`) and the wake match
fails.

**Fix — a position-gated WEAK homophone layer (`src/wakeWord.js`).** Added a
curated set of common-word homophones for the wake name (`don/dawn/done/john/
jon/on/dumb/…`, the -awn/-on family). To avoid false triggers on normal speech,
a weak match counts **only** when it (1) **leads** the utterance, (2) is in a
**short** utterance (≤ `WAKE_WEAK_MAX_TOKENS`, default **2**), and (3) is
**Whisper-confirmed**. `WakeSpotter.check()` now returns `via: 'strong' | 'weak'`.

**Confidence policy (`src/voiceReceive.js _detectWake`).** Trust the cheap Vosk
gate only for a **strong** match; anything weaker (Vosk empty / wrong / a mere
homophone) escalates short utterances to Whisper and requires Whisper to land on
a wake variant. So a bare low-confidence Vosk guess never triggers — a weak
homophone is accepted only when Whisper independently agrees.

**Wake sound — now fires on detection AND is logged.** The ack fires the instant
the wake word matches, before/independent of any command (`🗡️ wake word
DETECTED … playing wake sound now`), and `session.playSound` now logs each play
(`🔊 wake-sound: played "<file>"`) and warns if it's skipped (no channel /
missing file). Resolved sound: `screenshot.wav` (present), `AUDIO_SOURCE=system`
→ paplay to the local sink, relayed into the channel.

**Verified.** `wakeWord` matcher unit tests **28/28** (every observed mishearing
detected; `turn it on` / `i am done with that` / `on the server` / unrelated
words rejected). A live-backend harness fed TTS of the actual mishearings through
the **real** `_processSerial`: `Done!`/`John`/`Dawn` → confirmed-via-Whisper →
wake sound fired → armed; `turn it on please` → ignored; inline + non-wake
regressions intact (**11/11**). `npm run check` clean. New tunables:
`WAKE_WEAK_MAX_TOKENS` (default 2). Pending the user's live re-test before commit.

---

## 2026-06-25 — Voice end-of-speech silence cutoff raised 3.0s → 5.0s

**Problem.** Dictating a voice memo from across the room, the user was cut off
mid-thought: the command capture finalizes and submits after a fixed window of
trailing silence, and the old window was too short for slower, more distant speech.

**Exact current value found.** The end-of-speech timeout is
`WakeWordManager.silenceMs` — the SOLE thing that ends a command capture once speech
has started (`_checkVad`: `if ((now - this._lastVoiceAt) > this.silenceMs) stop`).
Its value comes from the `wakeSilenceMs` preference, but that key was **not persisted**
in the user's store, so the live value was the code default of **3000 ms (3.0s)** (the
"~3.5s" estimate was slightly high). It is read **live per recording**, not cached at
startup.

**Change.** Raised the default to **5000 ms (5.0s)** at every default site so a fresh
install and the unset-preference fallback both use 5.0s:
- `src/features/WakeWordManager.js` — `this.silenceMs = 5000` (constructor default) and
  the `_applyConfig` fallback `Number(prefs.wakeSilenceMs) || 5000`.
- `src/features/PreferenceManager.js` — default `wakeSilenceMs: 5000`.
- `renderer.js` — the two `p.wakeSilenceMs || 3000` UI fallbacks → `|| 5000`.
- `index.html` — "Stop after silence" slider `value="5000"` and label `5.0s` (range
  unchanged at 2000–10000, so the user can still tune it).

**Why this is the right knob.** `silenceMs` is the only trailing-silence end-of-speech
stop (there is deliberately no max-duration cap — long continuous speech is never cut),
and it's re-read on every VAD poll, so the change applies the moment the in-memory value
updates. The separate `SPEECH_IDLE_MS` (notification-hold debounce) was left untouched.

**Live vs. pending.** The committed code changes do NOT alter the already-running
renderer's in-memory `this.silenceMs` (still 3000 until the renderer reloads), so the new
default is **pending the next deliberate app restart**. Because the value is read live and
applied via `preference:changed`, the user can also make it take effect **immediately with
zero process disruption** by dragging the Settings → "Stop after silence" slider to 5.0s
(emits `preference:changed` → `_applyConfig` sets `silenceMs` live, and persists it). No
restart was performed for this change to avoid dropping the manager session (terminal 999).

---

## 2026-06-25 — Spoken notifications wait until the user stops talking (full barge-in hold)

**Problem.** Spoken (TTS) notifications could read out over the user while they were
mid-sentence talking to the assistant. An earlier pass (2026-06-24, commit `119db8d`)
added a partial fix — the wake word firing halted the *in-flight* clip — but it (a)
only reacted to the wake word, not to the user actually speaking, (b) **dropped** the
halted clip and the whole backlog, and (c) did nothing to stop the *next* queued
notification from starting while the user was still talking. The follow-up ("don't
autoplay new notifications while the user is speaking") was explicitly deferred.

**What we built.**

1. **A real "is the user speaking right now" signal.** `WakeWordManager._onAudioFrame`
   already computes per-frame mic RMS, but only used it *inside* a wake-command capture.
   Added `_updateSpeechSignal(rms)` which runs in **every** mic state and emits
   edge-triggered `speech:active` / `speech:idle` EventBus events — same RMS threshold
   and sustained-run gate as the wake VAD (so room blips don't trip it). The falling
   edge is detected in the frame handler itself because the Web Audio ScriptProcessor
   keeps firing during silence. Trailing silence before `speech:idle`: `SPEECH_IDLE_MS`
   (600ms), long enough not to flap between words of a sentence. The signal is also
   force-released on mic teardown so a held notification never gets stuck.

2. **A playback gate in `NotificationManager`.** It now tracks why it believes the user
   is speaking in a `_speakingSources` set, fed by three inputs: the new
   `speech:active/idle` (continuous RMS), `wake:state` `capturing`/`transcribing` (an
   active voice-command window), and `voice:button-state` `recording`/`processing` (the
   manual push-to-talk button). While any source is active — or within a trailing
   release window — `_drainQueue()` **holds**: queued notifications stay in order and
   nothing plays.

3. **Resume after a short silence, in order, nothing dropped.** When the last speaking
   source clears, a `SPEAKING_RELEASE_MS` (700ms) timer starts; if the user speaks again
   it's cancelled. On fire, the queue drains oldest-first. Combined with the 600ms RMS
   trailing silence that's a **~1.3s total quiet window** before a deferred notification
   reads out — within the requested ~1–1.5s. If a notification is mid-readout when the
   user starts talking, `_holdCurrentPlayback()` pauses it and **re-queues it to the
   front** (replaced the old drop-the-backlog `stopCurrentPlayback`, now removed), so the
   interrupted readout replays once the user is silent instead of being lost.

**No regression when silent.** With no speech (and the manual button idle), no source is
ever added, `_isUserSpeaking()` stays false, and notifications autoplay promptly exactly
as before. If the wake word is disabled there's no mic graph and thus no `speech:*`
events, so the manual-recording source is the only gate — silent operation is unchanged.

**Files.** `src/features/WakeWordManager.js` (signal: `SPEECH_IDLE_MS`,
`_updateSpeechSignal`, teardown release), `src/features/NotificationManager.js` (gate:
`_setupSpeakingGate`, `_addSpeakingSource`/`_removeSpeakingSource`, `_isUserSpeaking`,
`_holdCurrentPlayback`, `_drainQueue` guard, `SPEAKING_RELEASE_MS`).

**How to verify (requires a restart — not performed automatically; see note).** Restart
the app, enable the wake word, and trigger a notification (or let the manager post one)
while talking: it should not play until ~1.3s after you stop. Live-probe without a
restart by emitting the signal on the running renderer:
`window.eventBus.emit('speech:active', {})` (queue holds) then
`window.eventBus.emit('speech:idle', {})` (drains ~700ms later).

---

## 2026-06-24 — Stop chime on the silent no-speech auto-close of a wake/auto-wake window

**Problem (UX gap from testing #41).** When the auto-wake listening window opens after
a notification and the user says NOTHING, it closes on the no-speech timeout — but
silently. There was no audible cue that capture had stopped, so the user couldn't tell
the mic was no longer listening.

**Root cause.** The "done listening" stop chime (`this.stopSound`, `hud4.wav`) was only
played in `_onCommandRecorded` (`WakeWordManager.js`), on the path where audio is kept
and transcribed. The no-speech timeout in `_checkVad` calls `_stopCommandCapture(true)`
(abort=true); that routes into `_onCommandRecorded`'s discard branch, which returns
**before** the chime line — so the silent auto-close played nothing.

**Fix.** Play `_playChime(this.stopSound)` in the no-speech-timeout branch of
`_checkVad`, immediately before the abort. Now every natural termination of the listen
window fires the same stop sound exactly once:

- Speech captured & transcribed → `_onCommandRecorded` (existing play).
- Closed on trailing silence after speech → same transcribe path (existing play).
- **No-speech timeout with nothing said → new play in `_checkVad` (the gap, now fixed).**

**No double-play, by inspection.** The two play sites are mutually exclusive: the
no-speech branch fires only when the user never started speaking and then aborts (whose
discard branch returns before the transcribe-path chime); the transcribe path fires only
on the non-abort stop. The deliberate `cancelCapture` (user taps the yellow mic) and
`disable()` paths are intentionally left silent — they're user/system-initiated, not the
silent auto-close this addresses.

**Restart needed?** Yes — `WakeWordManager` runs in the renderer and is wired at app
start; the new chime activates on the next Electron launch. The app was NOT restarted as
part of this change.

---

## 2026-06-24 — Auto-wake after a notification (reply without the wake word)

**Want.** Make notification → reply a natural conversational turn: when a notification
finishes reading aloud, automatically open the capture flow for a brief window so the
user can fire back a reply immediately, no wake word needed. Only on the FIRST read-out
(not replays), and it must not fight the existing wake-word → halt-notification behavior.

**How it works (EventBus, decoupled — two managers, no reach-in).**
- `NotificationManager._onPlaybackEnded()` (the TTS `'ended'` handler) now emits a new
  `notification:read-complete` event — but only when the finished clip was a **first
  read-out** (not a replay) AND **nothing else is queued** AND not muted. First-vs-replay
  is tracked with a `_currentIsReplay` flag: set false when a clip starts from the
  autoplay queue (`_drainQueue`), true in `replay()`. The "nothing else queued" snapshot
  is taken before draining, so in a backlog only the LAST notification opens the window.
- `WakeWordManager` subscribes to `notification:read-complete` and calls the new
  `startPostNotificationCapture()`, which runs the **same** capture flow as the wake word
  (refactored into a shared `_beginCapture()`), tagged `_captureSource =
  'post-notification'`. It is a no-op unless the spotter is enabled and idle-listening
  (`state === 'listening'`), so it never interrupts an in-flight capture and can't clash
  with the wake path.
- **Listen window** = the configured stop-after-silence (`wakeSilenceMs`): `_beginCapture`
  passes `noSpeechMs: this.silenceMs`, so if the user doesn't start replying within that
  window the capture closes quietly (the same VAD silence logic as wake otherwise).
- **Tagging (routed to the manager):** `_sendToManager` keeps the verbatim
  `🎙️ Voice memo from the user` marker (the manager's CLAUDE.md keys off it) but, for a
  post-notification capture, frames it as `🎙️ Voice memo from the user [auto-started
  reply, right after a notification was read out — no wake word; …]` so the manager knows
  it's an immediate reply, not a wake capture. `_captureSource` resets to `'wake'` in
  `_resumeListening()` (one-shot).

**No conflict with wake → halt (the prior feature).** Auto-wake only fires on a
notification's *natural* completion with an empty queue. If the user instead says the
wake word mid-playback, `stopCurrentPlayback()` **pauses** the audio — which does not fire
`'ended'` — so that interrupted notification never triggers auto-wake (no double-capture).
When auto-wake starts and emits `wake:state 'capturing'`, the halt listener's
`stopCurrentPlayback()` is a clean no-op (the notification already ended, queue empty).

**Requires next app restart** (renderer modules). Per the constraint, the live Electron
app was NOT restarted (that would kill the manager 999 + all terminals).

**How to test (after the next restart, with the wake word enabled).** (1) Trigger a
notification: `curl -s -X POST http://localhost:8123/api/tts/speak/ -H 'Content-Type:
application/json' -d '{"text":"Reply test: say something after this finishes."}'`.
(2) When it finishes reading out, the activation chime plays and the mic opens — speak a
reply with no wake word; it should transcribe and reach the manager framed as an
"auto-started reply". (3) Stay silent instead → it closes quietly after the configured
stop-after-silence. (4) Press replay on an already-played notification → it must NOT
re-open the window. (5) Say the wake word mid-readout → the notification halts and only
the normal wake capture runs (no second auto-capture).

**Verified.** `node --check` passes on both managers; event wiring
(`notification:read-complete` ↔ `startPostNotificationCapture`) and the
first-play/replay gating confirmed by inspection. Live mic behavior to be confirmed by
the user after restart.

---

## 2026-06-24 — Kokoro TTS device detection (CUDA > MPS > CPU)

**Want.** Kokoro TTS should run on the GPU on a CUDA box (this RTX 3090 machine) and
fall back to CPU on a Mac, instead of always CPU.

**Change (`backend/text_to_speech/tts_service.py`).** Added `_resolve_device()` —
probes torch once and returns `'cuda'` if `torch.cuda.is_available()`, else `'mps'` on
Apple Silicon (`torch.backends.mps.is_available()`, guarded for older torch), else
`'cpu'`; any probe failure degrades to CPU. `_get_pipeline()` now passes the resolved
value as `KPipeline(..., device=device)`. Confirmed the installed **kokoro 0.9.4**
`KPipeline.__init__` accepts `device: Optional[str]` (forwarded to `KModel(...).to(device)`).
Safe and portable: no behavior change on a CPU host, GPU/MPS where available.

**BLOCKER found — the container is CPU-only by design, so this resolves to CPU here.**
The host is GPU-ready (`docker info` shows `Default Runtime: nvidia`, toolkit installed,
RTX 3090 present), but the backend image **deliberately installs the CPU-only torch
wheel** (`backend/Dockerfile:22`, commented "roughly halving image size") — so inside
the container `torch` is `2.x+cpu` and `cuda.is_available()` is `False` regardless of the
GPU. The backend code is also **baked into the image** (no code volume mount), so a plain
`docker compose restart backend` picks up neither the GPU nor this edit.

**Resolution — user approved the rebuild; GPU now active.** Two infra changes shipped:
- `backend/Dockerfile`: torch now installs from the **default PyPI wheel (CUDA build)**
  instead of the CPU-only index (`pip install torch`). Image grew ~3.02GB → **6.33GB**.
- `docker-compose.yml`: added `NVIDIA_VISIBLE_DEVICES=all` +
  `NVIDIA_DRIVER_CAPABILITIES=compute,utility` to the backend service so the nvidia
  container runtime actually exposes the RTX 3090 (the GPU was not being passed through
  before, even though the host default runtime is nvidia).

Rebuilt and recreated **only** the backend container (`docker compose build backend`
then `docker compose up -d --no-deps backend`). The Electron front-end, manager (999),
all terminals, and the Postgres `db` container were left untouched — verified after:
control-API `/state` listed all terminals alive, `db` still `Up 5 hours`, only `backend`
recreated. No volumes were pruned or touched (the host holds many other projects' DB
volumes — all off-limits).

**Verified GPU + speedup.** In-container: `torch 2.12.1+cu130`, `cuda.is_available()`
True, device `NVIDIA GeForce RTX 3090`. Kokoro model params load on `cuda:0` (≈578 MB
GPU mem). Warm single-sentence synth: **0.83s on CPU → 0.05s on GPU (~16× faster)**; the
real `POST /api/tts/speak/` endpoint returned HTTP 201 in ~0.09s. Brief TTS/voice outage
during the backend recreate, as expected; service healthy afterward.

**Activation note:** these are backend-container changes and are already live (backend
recreated). No Electron/front-end restart was performed.

**Want.** When the wake word fires and the user is about to speak a command, any
notification currently being read aloud (Kokoro TTS) must stop immediately so the
assistant isn't talking over them.

**Where the audio lives.** Spoken notifications are played in the renderer by
`NotificationManager`: a single reused `HTMLAudioElement` (`this.audio`) streams the
clip from the Django backend (`localhost:8123` `audio_url`), preceded by a short
heads-up chime (`this.headsUp`), with a small FIFO autoplay queue. (The backend only
synthesizes/serves the audio; playback and timing are entirely client-side.)

**Change (`src/features/NotificationManager.js`).** Added `stopCurrentPlayback()` —
pauses the current spoken clip and the heads-up chime, clears the autoplay backlog so a
queued clip can't immediately start over the user, and resets `playing`/`_currentId`.
The interrupted notification is left un-marked-as-played and stays in history (the user
can replay it); normal autoplay resumes for the next NEW notification. It does not touch
the persistent mute toggle. Wired via the EventBus (the codebase's decoupled pattern,
not cross-module reach-in): `WakeWordManager` already emits `wake:state` with
`{state:'capturing'}` the instant the wake word activates command capture, so
`NotificationManager` subscribes to `wake:state` and calls `stopCurrentPlayback()` on
`'capturing'`. The wake activation chime (a separate WakeWordManager audio element) is
unaffected.

**Scope note.** This implements the clear "halt on wake" requirement. A second, related
request ("…if the wake-up is currently active, do not delay to play the current
notification…") was cut off and is deferred for manager clarification — i.e. whether to
also SUPPRESS new notifications from autoplaying while a capture is in progress. Not done
here; today only the in-flight readout is halted.

**Activation / restart.** Renderer-module change — it takes effect on the user's **next
manual app restart**. Per the hard constraint, the Electron app was NOT restarted (that
would kill every terminal including the manager 999).

**How to test (after the next manual restart).** (1) Trigger a spoken notification so a
readout begins — e.g. `curl -s -X POST http://localhost:8123/api/tts/speak/ -H
'Content-Type: application/json' -d '{"text":"This is a long test notification being
read aloud so there is time to interrupt it."}'`. (2) While it is speaking, say the
configured wake word. (3) Expect: the readout cuts off immediately (activation chime
still plays, mic stays open for the command). Alternatively live-probe a freshly-loaded
app: `window.terminalGUI.eventBus.emit('wake:state', { state: 'capturing' })` while a
notification plays and confirm it stops.

**Verified.** `node --check` passes; the `wake:state` subscription and
`stopCurrentPlayback()` are present and wired.

---

## 2026-06-24 — Manager doctrine: the dimmed autosuggestion is not the user

**Want.** The manager (999) inspects terminals via `/terminal/screen` and decides
whether a terminal is "user-driven" (leave it alone) or idle (step in). Claude Code
renders a dimmed/greyed autosuggestion in the prompt's input line — text it proposes,
which the user has not typed. The manager must never mistake that for the user typing or
for a user instruction.

**Change (`src/main/manager-session.js`).** Added a permanent note to the generated
manager role doc (`MANAGER_CLAUDE_MD`), right after the screen-reading guidance: the
dimmed prompt-line autosuggestion is Claude Code's own suggestion ONLY — never a user
instruction and never evidence the user is driving a terminal; only actually-submitted
input or a genuinely running/prompted turn counts as user activity. Bumped
`MANAGER_MD_VERSION` v8 → v9 so existing manager directories get the refreshed doc on
next boot (the writer only rewrites when the in-file version marker is stale).

**Verified.** `node --check` passes; the version marker is `v9` and the note is present
in the template.

---

## 2026-06-24 — Voice dictation: never cut off mid-speech; honor the configured silence

**Want.** When you wake the assistant and speak a command, it must (1) keep listening
for as long as you keep talking — no matter how long — and (2) stop only after the
amount of trailing silence YOU configured ("Stop after silence", set to 3s), not some
other number. It had been cutting off mid-sentence and taking ~5s to stop despite the
3s setting.

**Which path it was.** Traced to the in-app wake-word capture (`WakeWordManager`), not
the Django transcription backend (which only transcribes an uploaded clip — no
silence logic) and not the manual mic button (`VoiceManager`, which records until you
click again — no auto-stop). The wake-word path is the one that "stops after silence"
and sends a voice memo to the manager, matching the symptom.

**Why "set 3s but ~5s".** The setting wiring is actually correct end-to-end: the
`#wake-silence-ms` slider persists `wakeSilenceMs` and emits a live `preference:changed`
that `WakeWordManager` applies immediately. There is no hardcoded `5000` in the path —
the running value is 3000ms. Two real causes remained: (a) the silence clock
(`_lastVoiceAt`) was refreshed by *every* audio frame above a fixed RMS gate, so room
tone/breathing during natural pauses kept nudging it — the configured value behaved as
a "minimum clean-silence gap" that drifts longer, not a wall-clock timer from when you
stop; the same fixed gate (0.015, too high) also froze the clock during quiet trailing
speech and clipped sentence ends; and (b) a separate hardcoded `maxCommandMs` 60s cap
hard-stopped long speech regardless of silence. (Also: `wakeSilenceMs` was missing from
the persisted store — consistent with the earlier stale-lock persistence freeze — so a
post-freeze slider change wouldn't have survived a restart; that lock is now cleared.)

**Change (`src/features/WakeWordManager.js`, `src/features/PreferenceManager.js`).**
- **Unlimited duration:** removed the `maxCommandMs` cap entirely (field, the
  `wakeMaxCommandMs` preference + its now-dead default). Long continuous speech is
  never cut by a time limit.
- **Silence is the sole stop:** `_checkVad` now, once speech has started, ends capture
  *only* when `now - _lastVoiceAt > silenceMs` (the user's configured value). The only
  other guard is a pre-speech bail (≈8s) that fires *only if you never start talking*,
  so a stray activation can't record forever — it can never interrupt actual speech.
- **Configured seconds = real trailing silence:** the silence clock now resets only on
  a short *sustained* voiced run (`VOICE_RUN_FRAMES = 2`, ~170ms) instead of any single
  frame, so isolated noise spikes during a pause can't stretch the stop past the set
  value; and the RMS gate was lowered 0.015 → 0.010 so quiet/trailing speech still
  registers (fixing the mid-sentence clip). Net: set 3s ⇒ stop ~3s after you actually
  stop talking. The value still applies live (no restart) via `preference:changed`.

**Verified.** `node --check` passes on both files; no remaining `maxCommandMs` /
`wakeMaxCommandMs` references anywhere. (VAD timing behavior to be confirmed live by the
user against a real utterance.)

---

## 2026-06-24 — Stale terminals resurrecting on restart: a frozen store caused by a dead lock file

**Want.** Old, unused terminals (e.g. the defunct SSH leftovers "Caltrack mobile" and
"jade", plus orphans like "Lyra") kept reappearing after a restart even though they'd
been deleted live. The persisted store needed to permanently match the live terminals so
nothing dead comes back.

**Root cause (the real bug).** Terminals persist to `~/.config/auto-injector/auto-injector.json`
under `settings.terminalMetadata` (written by `renderer.js` `persistTerminalMetadata()`,
read at launch by `restoreTerminalsAndQueue()`). The store had been **frozen since
2026-06-11**: a stale, empty lock file `auto-injector.json.lock` (left behind ~5 minutes
after the last good write, almost certainly a crash mid-write) was blocking every
subsequent save. `AtomicStore.acquireLock()` creates the lock with an exclusive `wx`
flag, so it kept hitting `EEXIST`, spun for its 15s timeout, and threw — so **no setting
had persisted for ~13 days**. Because `createBackup()` runs *before* the lock step in
`processQueue`, the 5-minute backups kept appearing (all identical copies of the frozen
file), which masked the failure. Result: the store was a June-11 snapshot, the manager's
live deletes never saved, and every restart restored the old June-11 terminal list.

**Fix (no app restart needed).** Investigated read-only, backed up the store first
(`backups/auto-injector-PRE-DBCLEAN-…json`), then moved the stale lock aside (to
`backups/STALE-LOCK-removed-…lock`, reversible) so writes could resume. Then triggered a
clean re-persist through the normal path — the same control API the manager uses,
`POST /terminal/update {terminalId:1}` — which fires `persistTerminalMetadata()`. That
rebuilds the metadata from the **live** terminals and writes it through `AtomicStore`,
updating both the on-disk file and the main-process in-memory cache. No manual JSON
surgery (which would have been clobbered by the cache anyway) and no restart.

**Result.** Persisted `terminalMetadata` now exactly equals live state — `1=limerence`,
`2=validate`, `3=db-fix` (manager 999 is excluded by design). Orphans gone: old
`2=Caltrack mobile`, `6=jade`, and stale `1=Lyra` no longer exist. Verified writes are
healthy again: the store mtime now advances on every save and the lock is created and
released cleanly each cycle (no lingering `.lock`/`.tmp`). The cleanup is durable across
the next restart.

**Latent bug worth a code follow-up (not done here).** `AtomicStore`'s lock has no
staleness/age check and no recovery — any crash mid-write bricks all persistence
indefinitely and silently. Worth adding a stale-lock breaker (e.g. ignore/reclaim a lock
older than the 15s timeout) and surfacing write failures instead of swallowing them.

---

## 2026-06-23 — Task J: Tap the yellow mic to cancel an auto-listening capture

**Want.** If the wake word triggers when the user didn't mean it, tapping the (yellow)
mic button should cancel the in-flight command capture — nothing transcribed, nothing
sent — without disturbing the button's other two behaviors.

**Where the click handler branches (renderer.js).** The single `#voice-btn` click handler
now branches on state up front: if `wakeWordManager.isCapturing()` is true (the YELLOW
`wake-listening` state), it calls `wakeWordManager.cancelCapture()` and **returns early** —
so the cancel does NOT also fall through to `eventBus.emit('voice:toggle')` (no
double-trigger, no manual recording started from the same click). Otherwise the existing
`voice:toggle` flow runs unchanged: a tap in the NORMAL state still starts manual
recording, a tap during the red `.recording` state still stops it.

**The WakeWordManager cancel path (new).**
- `isCapturing()` → `this.state === 'capturing'`. The renderer uses this (the authoritative
  manager state, not just the CSS class) to decide the tap means "cancel".
- `cancelCapture()` — no-op unless capturing; logs the cancellation, emits `wake:state`
  `'idle'` (clears the yellow immediately), then calls the existing
  `_stopCommandCapture(true)`. The `abort=true` flag is the key: it stops the recorder and,
  in `_onCommandRecorded`, routes to the `if (this._abortCapture) { discard; resume; return }`
  branch — which clears `commandChunks` and returns **before** the `transcribeBlob` /
  `_sendToManager` calls. After that, `_resumeListening()` rebuilds the recognizer and
  re-emits `wake:state 'listening'`, so the spotter keeps working for next time.

**How nothing can be sent after a cancel.** The only transcription/send path is
`_onCommandRecorded` → `transcribeBlob` → `_sendToManager`, and it is gated entirely behind
`!this._abortCapture`. `cancelCapture()` sets that flag (via `_stopCommandCapture(true)`)
*before* the recorder's async `onstop` fires, the VAD timer is cleared in the same call so
it can't re-stop with a non-abort flag, and the captured chunks are discarded. So once
cancelled, the recorded audio is dropped and neither Whisper nor the manager queue is ever
reached.

**Safety.** Branches only the YELLOW case; the normal/red manual paths are untouched.
`node --check` passes on `renderer.js` and `WakeWordManager.js`. (Live mic can't be
exercised here — to test: trigger the wake word, then tap the yellow mic mid-capture →
the yellow clears, the action log shows "Wake capture cancelled — nothing transcribed or
sent", and nothing is queued to the manager; a tap with the button idle still starts a
manual recording, and a tap while red still stops it.)

---

## 2026-06-23 — BUGFIX (Task I): Wake word false-triggered on non-keyword speech (root cause: grammar-restricted recognizer)

**Reported.** Saying "Mo" (and other random speech) triggered the wake phrase
"miranda". The exact-phrase + average-confidence gate added earlier was NOT rejecting
non-keyword speech.

**Root cause (confirmed, not guessed).** The Vosk spotter was **grammar-restricted**.
`_rebuildRecognizer` built `new this.model.KaldiRecognizer(16000, JSON.stringify([phrase,
'[unk]']))`. A Kaldi recognizer constrained to a tiny grammar **snaps any incoming audio
to the nearest in-grammar token** — so a short noise like "Mo" decoded to "miranda", and
because that was the model's best (only) in-grammar hypothesis it came back with *high*
confidence. That simultaneously defeated the exact-text match (the snapped text literally
*was* "miranda") and the confidence gate (the snapped confidence was inflated). No
threshold tuning could fix a recognizer that can only ever output the phrase.

**The fix — open-vocabulary decoding + whole-word match + confidence backstop, final-only.**
1. **Removed the grammar.** `_rebuildRecognizer` now constructs `new
   this.model.KaldiRecognizer(16000)` (full open vocabulary). Random speech now
   transcribes as ITSELF — "mo" → "mo", never "miranda" — so the snap-to-phrase problem
   that caused the false positives is gone at the root. The bundled
   `vosk-model-small-en-us` is a full model, so no new asset is needed.
2. **Whole-word phrase match.** `_onResult` now requires the wake phrase to appear as a
   **contiguous whole-word** sequence in the transcription (new `_findPhrase` helper),
   not a loose substring — so "amanda"/"veranda"/"mirandaesque" don't match, and a
   multi-word phrase like "hey claude" must appear as those two words in order.
3. **Confidence backstop on the matched words only.** The average confidence is now
   computed over just the matched phrase words (previously: all words), and must clear
   `matchThreshold`. With open-vocab the confidence is meaningful again (no longer
   inflated by grammar snapping), so it genuinely rejects mumbled near-homophones.
4. **Final-result only.** Dropped the `partialresult` trigger (and the old `_onPartial`).
   Partials carry no confidence and flicker through interim near-words, so triggering on
   them fought the "never false-trigger" goal. Triggering on the final result (fired at
   the natural pause after the wake word, before the command) costs only a little latency.

**Why this hits the target (≈100% true-negative, genuine still works).** Non-keyword
speech essentially never decodes to the exact word "miranda" as a standalone token in an
open-vocabulary model, so it can't pass the whole-word match — the primary filter — which
is what drives false positives to ~zero. A clear, genuine "miranda" decodes to "miranda"
with high confidence and passes both gates. Less-clear utterances may occasionally miss
(decode as a homophone or score under threshold), which is the deliberate accuracy-over-
sensitivity trade the user asked for.

**Strict default + working slider.** `wakeMatchThreshold` default raised **0.6 → 0.75**
in all four places (PreferenceManager default, WakeWordManager init, the `#wake-threshold`
slider `value` + its `75%` label, and renderer `syncWakeUI`'s fallback). The slider still
feeds `wakeMatchThreshold` live via `_applyConfig` (clamped 0–0.95) and now meaningfully
changes behavior because the confidence is real: raise it toward 0.95 to reject more
borderline matches, lower it if a genuine phrase is missed.

**Safety.** `node --check` passes on `WakeWordManager.js`, `PreferenceManager.js`,
`renderer.js`; no dangling refs to the removed `_onPartial`/`partialresult`/old
`_matchConfidence`. The manual (red) voice-recording path is untouched.

**Can't validate live mic here — how to test.** Relaunch the app on this branch (renderer
code loads at startup) with wake word enabled. Expected: saying **"Mo"** and assorted
random words/sentences = **no activation** (watch the action log — no "Heard …" line);
saying the real phrase **"miranda"** clearly = **activates** (chime + "Heard 'miranda'").
If genuine detection feels too strict, lower the Wake-word strictness slider; if anything
still slips through, raise it.

---

## 2026-06-23 — BUGFIX (Task H): Settings forms showed hardcoded defaults, not saved values

**The bug.** Opening Settings showed the wake-phrase input as "hey claude" even though
detection was correctly listening for the real saved phrase ("miranda" — saying it
worked). The form was displaying the HTML/JS default, not the persisted value. The new
sliders (wakeSilenceMs, injectionDelayMs, wakeMatchThreshold) had the same gap.

**Root cause (timing).** Preferences load asynchronously: `preferenceManager.initialize()`
(renderer.js:192) is **async and not awaited** — it does `await db-get-all-settings` and
only then populates `preferenceManager.preferences` and emits `preferences:applied`. But
`setupSecondaryUI` runs `syncWakeUI()` / `syncInjDelay()` **synchronously during init**, so
they read the *constructor defaults* (`'hey claude'`, 3000, 0.6, 400). Those sync functions
were never re-run — not on the load completing, not on settings-modal open — so the form
stayed frozen on defaults. Detection, by contrast, reads the saved phrase because
`WakeWordManager` subscribes to `preferences:applied` (fired after the DB load) — the exact
event the form ignored. So form and detection diverged.

**The fix (renderer.js).** Reflect the saved values at the right moments:
1. `syncWakeUI()` now also sets the two wake-sound `<select>` values from prefs (once their
   options exist), in addition to phrase/silence/threshold.
2. Captured both reflectors as `this._syncVoiceSettingsForms = () => { syncWakeUI(); syncInjDelay(); }`.
3. Subscribed it to `preferences:applied`, so when the async DB load finishes the form
   re-reflects the real saved values.
4. Called it again on every settings-modal **open** (`openSettings`), which covers the
   round-trip case (change → reopen → see the change; values are kept live in
   `preferenceManager.preferences` by `updatePreference`) and any missed load event.

Saving still flows the other direction unchanged: the input `change`/`input` handlers call
`preferenceManager.updatePreference(...)`, which persists AND emits `preference:changed`, which
`WakeWordManager._applyConfig` consumes live — so form↔detection stay in sync both directions.

**Verified each control loads its saved value:** wake phrase, wakeSilenceMs slider,
wakeMatchThreshold slider, injectionDelayMs slider, and the two wake-sound selects all read
from `preferenceManager.preferences` via the re-run path. The mute toggle (Task G) already
initialized correctly — it restores via `preferences:applied` → `_applyMutedState` →
`_updateMuteButtonUI`. The theme/sound/manager-input/TTS controls were already correct (they
read from awaited `getPersistedSetting` values in `wireSettingsControls`, not the un-awaited
`preferences`). `node --check` passes; the manual voice path is untouched.

---

## 2026-06-23 — Tasks F & G verified complete (no code change needed)

**F — "Manager input" disabled blocks EVERY path to terminal 999.** Confirmed fully
implemented: `MessageQueueManager.isManagerInputDisabled()` reads
`appStateStore.getState('settings.managerInputEnabled')` **live at send time**; two
enforcement points cover all paths — `canInjectToTerminal` short-circuits for tid 999
*before* `evaluateInjectionGate` (so even **urgent** is blocked), and a universal guard at the
top of `_injectToTerminal` (the single sink for both auto and force/"Send now") blocks the
force path that skips the gate. The auto "terminal finished → notify manager" push is also
suppressed at source in `ManagerInstance.onTerminalCompletion` (`!this.completionWatchEnabled`
returns early). The renderer mirrors the toggle into `appStateStore` at load and on every
change (immediate, no restart), and re-enabling calls `maybeAutoInject(999)` to flush held
messages. Default = enabled.

**G — Mute notifications is a real persistent toggle.** Confirmed: `#notification-mute-btn`
is a stateful `mute-toggle` (toggles `is-muted`, sets `aria-pressed`, swaps the icon
volume-2↔volume-x, swaps the label "Sound on"↔"Muted"). Muting pauses BOTH the spoken clip
and the heads-up chime and the queue stops draining (`_drainQueue` guard), so ALL playback is
silenced. State persists as the `notificationsMuted` preference and restores on
`preferences:applied`/`preference:changed` via `_applyMutedState` (no persist, no loop) plus
`_updateMuteButtonUI` on first toolbar render — survives restart.

---

## 2026-06-23 — Voice: 3s stop delay + yellow "listening" mic indicator

**The problem.** With wake-word auto-listening on, the only feedback that the system
was actively hearing your command was the activation sound — the mic button gave no
visual cue. The red/spinner button states were wired only to the *manual* VoiceManager;
the wake-word system emitted its own `wake:state` events but nothing in the renderer
listened to them. The trailing-silence cutoff was also a slightly sluggish 5 seconds.

**What changed.**

1. **Faster stop-after-silence: 5s → 3s.** Lowered the wake-word VAD trailing-silence
   default in all four places it lived: `WakeWordManager`'s `this.silenceMs` initializer
   and its `wakeSilenceMs` load fallback, the settings slider's default `value` plus its
   `3.0s` label in `index.html`, and the renderer's load-default in `syncWakeUI()`.
   Slider min/max/step (2s–10s) were left untouched, so a user can still dial it back up.

2. **Yellow "listening" + spinner feedback on the mic.** Added a `wake:state` listener in
   `renderer.js` (right beside the existing manual `voice:button-state` listener). It maps
   the wake-word states onto the `#voice-btn`: `capturing` (recording your command) adds a
   new `wake-listening` class for a pulsing yellow/gold glow; `transcribing` reuses the
   exact same `.processing` spinner the manual flow uses, so transcription looks identical
   in both modes; `listening`/`idle`/`error` clear both classes back to normal. The state
   strings were verified against what `WakeWordManager` actually emits.

3. **Independent yellow path in CSS.** Added `.wake-listening` rules in `style.css` modeled
   on the existing red `.recording` rules but in gold (`#f5c542`) — yellow background/border,
   a yellow box-shadow glow, and a gentle `wake-listening-pulse` keyframe. The mic icon stays
   visible (no spinner during capture). The red manual `.recording` path is untouched, so
   manual (red) and auto (yellow) feedback stay fully independent.

**Why it's safe.** The manual `voice:button-state` wiring and the red `.recording` CSS were
not modified, so manual recording and its blue spinner behave exactly as before. `transcribing`
reuses the existing `.processing` class/keyframes rather than introducing a parallel spinner.
`node --check` passes on `renderer.js` and `WakeWordManager.js`.

---

## 2026-06-23 — Manager-input gating fix + a real mute toggle (Tasks F, G)

Two changes, left uncommitted for review.

### F. "Manager input" disabled now blocks EVERY path to the manager (999)

**Root cause of the leak.** The "manager input" toggle (Notifications-tab + settings
checkboxes `#manager-input-enabled` / `#manager-input-enabled-setting`, persisted as
`managerCompletionWatchEnabled`, default **enabled/true**) only drove
`ManagerInstance.setCompletionWatchEnabled`, which gates a *single* path — the auto
"terminal finished → notify manager" push in `onTerminalCompletion`. Every other route to
terminal 999 was ungated: the **urgent** voice-memo (`WakeWordManager` →
`addMessage({terminalId:999, type:'urgent'})`), the `PromptWatchManager` push, normal queue
injection, and the manager's own `/queue/add` control API. Worse, two structural bypasses let
urgent/forced messages through even at the gate: `evaluateInjectionGate` lets **urgent bypass
everything**, and `injectMessageNow` ("Send now"/force) **skips the gate entirely** and calls
`_injectToTerminal` directly. So an urgent message reached the manager despite the toggle.

**Fix — gate at the injection chokepoint, read live.** Added `MANAGER_TERMINAL_ID = 999` and
`isManagerInputDisabled()` to `MessageQueueManager`; the latter reads
`appStateStore.getState('settings.managerInputEnabled')` **at send time** (never cached;
`undefined`/`true` = enabled, only explicit `false` disables). Two enforcement points:
1. `canInjectToTerminal` short-circuits to `{allowed:false, reason:'manager input disabled'}`
   for tid 999 — placed **before** `evaluateInjectionGate`, so it also blocks urgent. This
   covers the auto path (`maybeAutoInject`), the toolbar/manual path
   (`manualInjectNextMessage`), and the legacy `injectMessageAndContinueQueue` — all of which
   consult `canInjectToTerminal`.
2. A universal guard at the top of `_injectToTerminal` (the single sink for both the auto and
   the force/"Send now" paths) — guarantees no path injects to 999 while disabled. The message
   stays queued and flushes when re-enabled.

Renderer mirrors the toggle into `appStateStore` (`settings.managerInputEnabled`) both at
startup load and on every toggle change, so flipping it takes effect immediately with no
restart; re-enabling also calls `maybeAutoInject(999)` to flush any held messages. The pure
`evaluateInjectionGate` policy (and its unit tests) was deliberately left untouched.

**Default kept:** enabled (`managerCompletionWatchEnabled` default `true`). **Confirmed blocked
when disabled:** urgent voice-memo → `addMessage(999,'urgent')` → `maybeAutoInject(999)` →
`canInjectToTerminal(999,'urgent')` returns blocked *before* the urgent bypass; force "Send now"
→ `_injectToTerminal` top guard returns early; auto completion push → suppressed at
`onTerminalCompletion` *and* blocked at the gate. `node --check` passes.

### G. Mute notifications is now a real, persistent toggle switch

**What changed.** The bare `#notification-mute-btn` icon button became a stateful toggle
(`class="mute-toggle"`, `aria-pressed`, an icon + a `.mute-toggle-label`). New CSS gives an
unmistakable two-state look: subdued "Sound on" (volume-2) when unmuted, filled red
"Muted" (volume-x) when muted. `NotificationManager` was split into `_applyMutedState()`
(applies to playback + UI, no persist — used by the restore/sync event handlers) and
`setMuted()` (applies **and** persists by emitting `preference:update`), avoiding a feedback
loop with `PreferenceManager`. Muting now pauses BOTH the spoken clip and the heads-up chime,
and `_drainQueue`'s existing `this.muted` guard keeps the whole queue from draining until
unmuted (silences ALL playback, not just the current clip). State persists under the new
`notificationsMuted` preference (default `false`) and is restored on `preferences:applied`,
so it survives navigation/restart; `_updateMuteButtonUI()` is also called on first toolbar
render. `node --check` passes; the manual voice path and wake-word B/C/D work are untouched.

---

## 2026-06-23 — Wake word: verify the stop-delay, expose send delay, cut false positives

Three changes to the voice/queue stack (Tasks B–D). All left uncommitted for review.

### A. Barge-in guard — REMOVED by user decision

This task originally added a self-trigger guard that muted the wake-word listener while the
app's own TTS/NotificationManager audio played (a `tts:playback` event broadcast from
`NotificationManager`, a `this.suppressed` flag + `_resumeTimer` and `PLAYBACK_RESUME_TAIL_MS`
tail in `WakeWordManager`, plus detection gates). **It was fully removed at the user's request**
because of the stuck-listening risk (if the resume signal were ever missed, the spotter could
stay muted). False positives are instead handled by the stricter wake-word matching/threshold
in Task D. Reverted cleanly: `NotificationManager` and `WakeWordManager` are back to their
pre-Task-A behavior for the TTS/wake interaction, with no orphaned flags, listeners, methods,
or constants (`grep` confirms zero references to the removed symbols).

### B. Verified the "Stop after silence" slider end-to-end (and fixed the real default)

**Verified wiring (already worked):** slider `#wake-silence-ms` `input` handler
(`renderer.js:1003-1006`) updates the `#wake-silence-value` label live AND calls
`preferenceManager.updatePreference('wakeSilenceMs', …)`, which persists
(`PreferenceManager.updatePreference` → `savePreference`) and emits `preference:changed`.
`WakeWordManager` subscribes and applies it **live** via `_applyConfig` →
`this.silenceMs = Math.max(1000, …)`; the VAD consumes `this.silenceMs` to end capture.

**Bug found + fixed.** `PreferenceManager`'s default still said `wakeSilenceMs: 5000`, which
is emitted on `preferences:applied` and would override the constructor's 3000 for any fresh
user — so the earlier "3s default" change was being defeated at the authoritative source.
Changed that default to `3000`. Now the default is genuinely 3s everywhere.

### C. Exposed the "Queue send delay" in Settings

**Investigation.** The only pref-backed injection delay, `injectionDelayMs` (default 1000),
lived in `MessageQueueManager.scheduleNextInjection`, which belongs to the **legacy** sequential
engine that the live per-terminal parallel path (`maybeAutoInject` → `_injectToTerminal`)
superseded — so that knob is effectively dead. The real "delay before the next queued message
is sent to a terminal" in the live engine was the hardcoded `400ms` re-drain in
`_finishInjection`. There was no Settings control either way, and `MessageQueueManager.preferences`
was never populated (stayed `{}`), so even the existing consumer never read a saved value.

**What changed.** Added a "Queue send delay" slider (`#injection-delay-ms`, readout
`#injection-delay-value`, range 0–3000ms step 100, default **400** to match the existing
hardcoded re-drain), wired in `renderer.js` to persist `injectionDelayMs` and update its label
live. `MessageQueueManager.setupEventListeners` now mirrors `preferences:applied` /
`preference:changed` into `this.preferences`, and `_finishInjection` reads
`this.preferences.injectionDelayMs` (fallback 400) for the re-drain wait. Default 400 preserves
current behavior exactly. (Bonus: populating `this.preferences` also makes the previously-dead
`keepScreenAwake` read live.)

### D. Stricter wake matching + a "Wake-word strictness" slider

**Matching mechanism found.** The Vosk recognizer used a grammar restricted to
`[phrase, '[unk]']`, and `_onPartial` fired `_onWakeDetected` on a loose **substring** match
(`norm.includes(phrase)`) for BOTH partial and final results — no confidence check at all.
Partial/interim hypotheses are the biggest false-positive source.

**What tightened (highest-leverage).** (1) Final results now go through a new `_onResult` that
requires an **exact** phrase match plus an **average word-confidence ≥ `matchThreshold`**
(`setWords(true)` is requested so confidences are available; if absent it falls back to the
exact-text match rather than blocking). (2) `_onPartial` now requires an **exact** phrase match
instead of a substring. Both are strictly tighter than before.

**New setting.** "Wake-word strictness" slider (`#wake-threshold`, readout
`#wake-threshold-value`, range 0–0.95 step 0.05, default **0.6**, shown as a percentage),
persisted as `wakeMatchThreshold` and applied live in `WakeWordManager._applyConfig`
(`this.matchThreshold`, clamped 0–0.95). Higher = stricter.

**Real phrase preserved.** A clearly spoken "hey claude" resolves to exactly the phrase under
the restricted grammar with high confidence (typically ≫0.6), so it still fires; the default
0.6 only rejects garbled, low-confidence near-matches. The slider lets the user raise strictness
toward 0.95 if false positives persist, or lower it if their genuine phrase is missed.

**Safety.** `node --check` passes on all changed files (`renderer.js`, `WakeWordManager.js`,
`PreferenceManager.js`, `MessageQueueManager.js`; `NotificationManager.js` was reverted to
pre-Task-A state). Could not launch the Electron app in this environment; verified by code
inspection, syntax checks, and tracing each pref → consumer path. The manual voice path and
red `.recording` UI remain untouched.

---

## 2026-06-08 — P1: Reliable per-terminal `runtime` (and live `directory`) in `/state`

**The problem.** The manager could not reliably tell, from `GET /state`, whether a
terminal was running Claude, sitting at a bare shell, or idle *inside* Claude. The
`status` field (`running`/`prompted`/`...`) is driven by Claude Code hooks, and
`sessionId`/`directory` were only filled in *after* the first hook fired — so a
freshly launched Claude read `sessionId: null` and looked identical to a bare shell
(both showed status `...`). The only workaround was dumping `/terminal/screen` and
eyeballing the TUI.

**What changed.** Each terminal in `/state` now carries a new `runtime` field:

- `"claude"` — Claude Code is genuinely running in this PTY
- `"shell"`  — a bare shell (or a non-Claude command)
- `"unknown"` — no live PTY / process gone

It is derived from the PTY's real process tree (via `/proc`), independent of whether
any hook has fired. The signal is exact: the `claude` CLI names its process
`claude`, so a descendant of the PTY's shell with that process name means Claude is
alive; a shell with no such descendant is a bare shell. The same pass also reads each
PTY's **live working directory** from the process and uses it for `directory`, so the
directory is correct immediately on a fresh terminal instead of `null`.

**Why it helps.** Combined with the existing `status`, the manager can now read state
without screen-dumping:

| `runtime` | `status`   | meaning                                  |
|-----------|------------|------------------------------------------|
| `shell`   | (any)      | bare shell — unsafe to inject a prompt   |
| `claude`  | `...`      | idle in Claude                           |
| `claude`  | `running`  | Claude running a turn                    |
| `claude`  | `prompted` | Claude awaiting input                    |

**Where the code lives.**
- New module `src/main/terminal-runtime.js` — pure, `/proc`-based detection
  (`detectRuntime`, `liveCwd`, `enrichSnapshot`); no Electron/node-pty dependency.
- `main.js` — the hook server's `getState` now wraps the renderer's cached snapshot
  with `enrichSnapshot(...)`, computed fresh on every `/state` GET. `HookServer.js`
  and the renderer are untouched.
- Tests: `src/main/terminal-runtime.test.js` (10 cases, `node --test`), plus a
  real-`/proc` sanity check confirming a live claude-shell reads `claude` and a bare
  shell reads `shell`.

**Backward compatibility.** Purely additive — `runtime` is a new field and `status`
semantics are unchanged. Existing consumers keep working.

**Requires a restart to take effect.** The only live-process change is the
`getState` wiring in `main.js`, which is loaded once at app startup. The running app
keeps serving the old `/state` until the Electron app is quit and relaunched. The new
module and tests do not affect the running app.

---

## 2026-06-08 — P1.5: Notify the manager when a worker is awaiting input

**The problem.** The interface already pushes a message to the manager (terminal
999) when a worker *finishes* a turn, but it stayed silent when a worker became
*blocked waiting on a human* — a permission dialog or an interactive menu. As the
orchestrator, the manager was blind to blocked workers and only learned of them if a
human said so, which defeats hands-off management.

**The catch.** The raw `prompted` status is not trustworthy as a "needs input"
signal: Claude's idle Notification hook also fires during long, high-effort thinking
turns, so triggering on status alone would spam the manager.

**What changed.** When a worker transitions into `prompted` (from a Claude hook), the
interface now waits briefly for the menu to paint, reads that terminal's on-screen
buffer, and only notifies the manager when the screen actually shows an interactive
prompt — detected by Claude's selector signature (the `❯` selection cursor next to
two or more numbered options). A long thinking turn shows no such menu, so it is
suppressed. The push reuses the manager's existing dispatch path (queues to 999) and
includes the terminal id + title, the notification message, and the parsed
**question and its options**, so the manager can answer without dumping the screen.

**Why the screen check is also the shell guard.** A bare shell cannot render a Claude
`❯` numbered menu, so requiring that on-screen signature inherently prevents notifying
on shell noise — P1's `runtime` field is not even needed here.

**De-dup.** A prompt is announced once per occurrence (keyed on its question +
options); the key resets when the terminal leaves `prompted`, so a genuinely new
prompt later is announced again.

**Where the code lives.**
- New `src/features/prompt-detector.js` — pure parser
  `detectPrompt(screen) -> { question, options } | null`.
- New `src/features/PromptWatchManager.js` — subscribes to
  `terminal:status:changed`, screen-checks on the prompted transition, de-dupes, and
  dispatches the note to 999. Gated by a new `managerPromptWatchEnabled` setting
  (defaults on). Touches neither `ManagerInstance` nor `main.js`.
- `renderer.js` — extracted a reusable `readTerminalScreen()` (the `/terminal/screen`
  endpoint now uses it too) and instantiated `PromptWatchManager`.
- Tests: 8 detector cases + 9 watcher cases (`node --test`), covering boxed/unboxed
  permission prompts, select menus, plain prose, thinking turns, de-dup, the
  enable/disable setting, and the 999 self-exclusion.

**Scope note.** Detects interactive menu/permission prompts (what was asked for).
Free-text prompts with no menu are out of scope for now.

**Requires the same restart.** The change is in the renderer (loaded at startup), so
it takes effect on the same relaunch as P1.

---

## 2026-06-08 — P2: Claude lifecycle + raw-key control endpoints

**The problem.** There was no clean way to start, resume, or restart Claude in a
terminal, or to send a control key (Esc, Ctrl-C, Enter). The only lever was queueing
the literal text `claude` as if typing at a shell — and when a terminal's state was
ambiguous, multi-line messages leaked into bash and ran as commands.

**What changed.** Two new control endpoints:

- `POST /terminal/keys` — `{ terminalId, keys }` where `keys` is a string or array
  of tokens. Named keys (`Ctrl+C`, `Esc`, `Enter`, `Up`, `Shift+Tab`, …) become the
  right control bytes; anything else is sent literally, so you can mix them — e.g.
  `["2","Enter"]` answers menu option 2. Writes straight to the PTY (bypasses the
  injection queue/gate, on purpose — Ctrl-C must work even mid-timer).
- `POST /terminal/claude` — `{ terminalId, action }`:
  - `start` — runs `claude` (with optional sanitized `args`), **only if the terminal
    is a bare shell** (`runtime === 'shell'`). Refuses if Claude is already running
    or the runtime is unknown — this is what prevents the multi-line-into-bash leak.
  - `resume` — `claude --continue`, or `claude --resume <sessionId>` when a valid
    (`[A-Za-z0-9._-]+`) session id is given; same shell-only guard.
  - `restart` — if Claude is running, interrupts it (Ctrl-C twice), waits for the
    shell to return, then relaunches; if already at a shell, just starts.

**Why it's main-side.** Unlike terminal create/delete (a renderer/xterm concern),
these are PTY-level. The PTYs and P1's `/proc` runtime detector both live in main, so
main handles these actions directly — writing to the PTY with no renderer round-trip
and using `runtime` as the guard. The renderer is untouched.

**Safety.** Session ids are pattern-validated; `args` have control characters and
newlines stripped, so a value can't smuggle an extra command past the trailing
carriage return.

**Where the code lives.**
- New `src/main/pty-control.js` — `translateKeys()` + `handlePtyControl()` (raw keys,
  start/resume/restart), dependency-injected and unit-tested (15 cases).
- `src/main/HookServer.js` — two new routes added to `CONTROL_ROUTES`.
- `main.js` — `onControl` now routes `terminal-keys` / `terminal-claude` to
  `handlePtyControl` (with `ptyFor`/`runtimeFor`/`sleep`), everything else still
  round-trips to the renderer.

**Requires the same restart.** Routes and the main-side handler are loaded at startup.

---

## 2026-06-08 — P4: Injection leak-guard (don't inject prompts into a bare shell)

**The problem.** A bare shell shows status `...` (idle), which passed the injection
gate — so a queued prompt was written into bash and each line ran as a command
("command not found"). The gate had no way to know the terminal wasn't running Claude.

**What changed.** The injection gate now refuses to inject into a terminal whose
ground-truth runtime is a bare shell. A blocked message is **not lost** — it stays
queued (dequeue only happens after a successful write) and injects once Claude is
running. The guard sits above the status gate, so even `urgent`/`important` cannot
push a prompt into bash. It triggers only on a definitive `shell`; `claude`,
`unknown`, and not-yet-known all fail open, so injection is never broken when the
runtime is undetermined.

**How the renderer learns the runtime.** A lightweight watcher in main polls each
PTY's `/proc` runtime (~2.5s, pushes only on change) and sends it to the renderer,
which stores it on the terminal. The gate reads it synchronously — no blocking IPC in
the gate, and the leak-critical claude→shell transition is caught within one poll.

**Coherent story across P1/P1.5/P2/P4.** P4 *blocks* the leak; P2 gives the *fix*
(`POST /terminal/claude start`); P1 + P1.5 give the *visibility* (the `runtime` field
and the awaiting-input notification). A prompt queued to a bare shell now waits
safely until Claude is started, instead of running as shell commands.

**Behavior change to note.** Previously a `normal` message to an idle bare-shell
terminal would inject (and leak). Now it is held in the queue with the reason
`terminal N is a bare shell (no Claude session)` until that terminal runs Claude.

**Where the code lives.**
- New `src/messaging/injection-gate.js` — pure `evaluateInjectionGate(state)` holding
  the full gate precedence including the shell guard (8 tests). The existing
  `canInjectToTerminal` was refactored to gather state and delegate to it (every
  prior reason preserved; the shell guard added).
- `main.js` — the `/proc` runtime watcher (`setInterval`, push-on-change).
- `renderer.js` — stores pushed `runtime` on the terminal via a `terminal-runtime`
  IPC handler.

**Requires the same restart.** The watcher (main) and the IPC handler (renderer) load
at startup.

---

## 2026-06-08 — BUGFIX: queue didn't auto-resume when a usage limit lapsed

**The bug.** When a terminal was paused by a usage/session limit, the interface ran a
countdown to the reset time. When that countdown hit 0, the queued messages should
have injected automatically — but the queue stayed frozen until something else (e.g.
enqueuing a new message) kicked it. Observed live with 4 messages stuck after a reset.

**Root cause (traced, not guessed).** The injection gate refuses to inject while
`timerManager.isRunning()` is true. `TimerManager` only clears its countdown interval
on an error or an explicit `stopTimer()` — when a countdown reaches 0 it sets
`timerExpired = true` but **leaves `timerRunning = true`**, so `isRunning()` stays
true indefinitely. The usage-limit "limit cleared" handler
(`UsageLimitManager.handleUsageLimitTimerExpiry`) released the *usage-limit* half of
the gate (`usageLimitWaiting = false`) and emitted `usageLimit:reset`, but never
released the *timer* half. So when `MessageQueueManager` re-drained on
`usageLimit:reset`, `canInjectToTerminal` still returned "timer still counting down"
and nothing injected. The enqueue path (`maybeAutoInject`) worked later only because
by then the gate happened to be open — matching the observed "drains the instant a
new message is enqueued."

**The fix.** `handleUsageLimitTimerExpiry` now stops the commandeered timer
(`timerManager.stopTimer()`) right after clearing `usageLimitWaiting`, before emitting
`usageLimit:reset`. With both halves of the gate released, the existing re-drain
injects the pending messages automatically — no new enqueue needed.

**Regression test.** `src/features/usage-limit-resume.test.js` drives the **real**
`UsageLimitManager.handleUsageLimitTimerExpiry` against the **real**
`evaluateInjectionGate`: a message queued, usage-limit waiting, timer "running";
firing expiry must release both gate halves and inject the message with no new
enqueue. (Loads the real ULM in plain node via an `electron` require shim.) Plus a
test asserting the `timer:expired` event drives the same resume, and one pinning the
root cause (a still-"running" timer blocks the gate).

**Related latent issue (NOT fixed — out of scope).** The same root cause means a
*manual* auto-inject timer expiring would also leave `isRunning()` true and block
injection. Only the usage-limit path is fixed here; the general timer-expiry case is a
separate decision.

**Requires the same restart.** The fix is in `UsageLimitManager.js` (renderer), loaded
at startup, so it takes effect on the same relaunch as the rest.

---

## 2026-06-08 — P3: Transcript read endpoint (last N parsed messages)

**The problem.** Reading what a worker has been doing meant the manager hand-parsing a
big JSONL transcript off disk. The app only ever extracted the single last assistant
message (for completions); there was no way to get the recent conversation.

**What changed.** New `POST /terminal/transcript` `{ terminalId, limit? }` returns the
last N (default 20, max 100) **conversational turns** as
`{ role: "user"|"assistant", text, ts }`, oldest-first:

- Human prompts and assistant replies are included.
- Assistant turns that only call tools become a compact `[tool_use: Bash, Edit]`
  marker so activity is visible without dumping raw tool output.
- Sidechain (subagent) entries, thinking blocks, and raw tool_result output are
  skipped. Each message is truncated to 4000 chars.

The terminal's transcript path is resolved **server-side** from the `/state` snapshot
(never from a caller-supplied path), and a terminal with no session yet returns a
clean `ok:false` instead of an error.

**Where the code lives.**
- `src/main/transcript-reader.js` — generalized from last-assistant-only to add
  `readRecentMessages()` (the parser) and `buildTranscriptResponse()` (resolves the
  path from the snapshot and shapes the response). The existing
  `readLastAssistantText()` is unchanged. Reads a 4 MB tail (enough for ~20 turns
  even amid large tool output).
- `src/main/HookServer.js` — `/terminal/transcript` route added to `CONTROL_ROUTES`.
- `main.js` — `onControl` handles `terminal-transcript` locally (a main-side file
  read), resolving the path from the cached snapshot.
- Tests: `src/main/transcript-reader.test.js` (9 cases) over a fixture matching the
  real schema, plus a sanity run against a real transcript.

**Backward compatible.** Purely additive; `readLastAssistantText`/completions
unaffected.

**Requires the same restart.** The route and handler load at startup.

---

## 2026-06-08 — BUGFIX: manual auto-inject timer didn't resume the queue at 0

**The bug (same class as the usage-limit one).** When a manual auto-inject timer
counted down to 0, the queue did not drain. The auto-inject feature is "wait N, then
inject", but injection never fired after the wait.

**Root cause.** `TimerManager.isRunning()` returned `timerRunning && !timerPaused`.
A countdown that reaches 0 sets `timerExpired = true` but leaves `timerRunning = true`
(the interval is only cleared on error/explicit stop). So `isRunning()` stayed true
after expiry, and `canInjectToTerminal` kept blocking with "timer still counting
down" — the same stuck-gate as the usage-limit bug, but on the general timer path.

**The fix.** `isRunning()` now also excludes the expired state:
`timerRunning && !timerPaused && !timerExpired`. An expired timer is not "running", so
at 0 the gate reopens and the existing `timer:expired → MessageQueueManager.handleTimerExpired → drain`
path injects the pending messages. This is the source-level fix and complements the
usage-limit fix above: the `isRunning()` change covers the countdown-reaches-0 path;
the `UsageLimitManager.stopTimer()` change still covers the usage-limit wall-clock
path (limit lifts while the timer is mid-count, before `timerExpired` is set).

Every `isRunning()` caller wants `false` after expiry (the injection gate and the
injection-loop guard both block while it's true; the usage-limit manager only consults
it during active waits, where `timerExpired` is false), so the change is safe.

**Regression test.** `src/features/timer-expiry-resume.test.js` drives the **real**
`TimerManager` to 0 (via `decrementTimer`) and asserts `isRunning()` is false and the
**real** `evaluateInjectionGate` then allows injection — i.e. the queue can drain.

**Requires the same restart.** The fix is in `TimerManager.js` (renderer).

---

## 2026-06-09 — BUGFIX: cost calculator never worked (ran ccusage in the wrong process)

**The bug (recurring).** The pricing/cost view always showed an error or nothing.
Earlier passes "wired" the UI (`98a9d0d`) but the numbers never appeared.

**Root cause (proven live, not guessed).** The renderer fetched
`POST http://localhost:8123/api/ccusage/`, and the Django backend ran
`npx ccusage daily --json` to read the Claude Code logs in `~/.claude/projects`.
But per the project's own rule the backend runs **in Docker**, and that container
(a) ships **no Node/npx** and (b) does **not mount** the host's `~/.claude`. So the
endpoint could only ever return `{"success":false,"error":"ccusage unavailable
(npx/Node not found on PATH)"}` — confirmed with a live `curl` against the running
container, and `docker compose exec backend which npx node` returns nothing. The
data ccusage needs (Node + the logs) lives **only on the host**, so no amount of
renderer/backend wiring could fix it. Every prior attempt patched the wrong layer.

**The fix (right layer).** Run ccusage in the **Electron main process**, which runs
on the host where `npx` and `~/.claude/projects` both exist. New
`src/main/ccusage.js` shells out to `npx -y ccusage daily --json`, shapes the JSON
exactly like the old backend response, and is exposed over IPC as `get-ccusage`.
`renderer.js#loadPricingData()` now calls `ipcHandler.invoke('get-ccusage')`
instead of fetching the backend. The Docker backend is no longer in the cost path
at all, so it works in the default Docker deployment.

**How verified.**
- Unit: `src/main/ccusage.test.js` (8 cases, `node --test`) — daily/weekly/total
  math + rounding, today/week windowing, and the failure modes (npx missing,
  timeout, auth error, non-JSON) all return clean `{success:false}` without throwing.
- Runtime (live-probed the real app via Playwright on this branch): IPC
  `get-ccusage` returned real figures (daily **$44.45**, weekly **$1052.12**, total
  **$3222.67** over 44 days), and after `loadPricingData()` the DOM cost cards read
  `$44.45 / $1052.12 / $3222.67`, `#pricing-data` visible, `#pricing-error` hidden.

**Restart needed?** Yes — the change is in `main.js` (IPC handler, loaded once at
startup) + the renderer, so the running app must be relaunched onto this branch.
Verified post-(fresh-launch). No backend/Docker dependency remains for pricing.

---

## 2026-06-09 — BUGFIX: message input box didn't grow/shrink with content

**The bug.** The `#message-input` textarea stayed one row tall no matter how much
was typed; long multi-line prompts were stuck behind a tiny scrollbar instead of
the box expanding.

**Root cause.** A `<textarea>` does not auto-size to its content — that always
requires JS to measure `scrollHeight` and set the height. The CSS
(`.chat-input #message-input`) already had `min-height`/`max-height:200px`/
`overflow-y:auto`, but nothing ever updated the element's height, so it never grew.

**The fix.** `renderer.js` now binds an `input` handler that does the standard
auto-size dance: set `height='auto'` (so it can shrink), then
`height = scrollHeight + 'px'` (so it grows). The CSS `max-height:200px` caps it
and `overflow-y:auto` takes over with a scrollbar past that. It's also reset after
a message is sent (textarea cleared → collapse back to one row) and sized once on
startup.

**How verified (live-probed the real app via Playwright).** Typing 1/3/6/10/30
lines produced heights 28 → 67 → 125 → 200 (capped) → 200 (capped, scrollbar
active), and removing text shrank it back through 67 → 28. No per-keystroke height
creep (border-box is clean). Assertions: grows ✓, caps at max with scroll ✓,
shrinks back to one row ✓.

**Restart needed?** Yes — renderer change, loaded at startup; relaunch the app onto
this branch.

---

## 2026-06-09 — Sound effects: close the cold-start gap + delete a broken duplicate path

**Status going in.** Reported "still broken" across multiple prior attempts. Live
investigation on this branch (Playwright, real button clicks) showed the core path
already FUNCTIONS: `new Audio('./assets/soundeffects/confirm.wav').play()` resolves
and plays, `cloneNode()` plays too (the earlier "cloneNode is the bug" theory was
wrong), the toggle flips `soundManager.soundEnabled`, and the three test buttons
each call `playSound` with the audio loaded (`readyState 4`). So there was no
single dead switch — but there WERE two real defects worth fixing.

**Defect 1 — cold-start window.** `setupSettings()` wired the sound toggle and
test buttons only AFTER `await soundManager.initialize()` (an IPC dir-read), and it
first did 7 *sequential* `getPersistedSetting` IPC awaits. So for ~1-2s after
launch the sound controls were unbound — toggling did nothing. **Fix:** load the 7
persisted settings in parallel (`Promise.all`) and wire the controls BEFORE the
async sound-file load. The sound `<select>`s repopulate when files arrive — keyed
on `sound:update-ui` (emitted at the END of `initialize()`, after stale-pref
healing) rather than `sound:files-loaded` (mid-init, pre-heal, which would leave
the dropdown on a non-existent `.mp3` → blank). Repopulation is idempotent
(`sel.onchange`, not `addEventListener`). Measured: toggle now wired within ~1s of
launch; dropdowns show all 20 real `.wav` files with a valid healed selection
(`confirm.wav`) by ~2s.

**Defect 2 — broken duplicate sound path.** `CompletionManager` had its OWN
`checkCompletionSoundTrigger`/`playCompletionSound`/`testCompletionSound` that ran
on every completion in parallel with SoundManager's. It used the wrong asset dir
(`new Audio('sounds/…')` — the files live in `assets/soundeffects/`) and a setting
key (`completionSoundEnabled`) that is never set, so it silently failed every time.
**Fix:** removed it; completion/prompted/injection sound is owned solely by
`SoundManager`. Verified a `running→'...'` status change still plays via SoundManager
with no error and the removed methods are gone.

**How verified (live).** Steady-state sampling 1-9s after launch: toggle wired,
20-file dropdown, valid selection; test buttons fire `playSound` with audio loaded;
completion event plays through SoundManager; removed CM methods are `undefined`.

**⚠ Restart REQUIRED — this is the crux of "still broken".** All sound logic is in
the renderer, loaded once at startup. A running instance from before this branch
keeps the old (unwired / mid-init-gated) behavior no matter what you toggle. **You
must quit and relaunch the app onto this branch (rebuild if packaged).**

**If it is STILL silent after a clean relaunch of this branch, check, in order:**
1. **You're actually on this branch / freshly rebuilt** — not a stale Electron
   process. Confirm the dropdowns list real `.wav` files (beep/click/confirm/…); if
   they show `.mp3` names, you're on old code.
2. **System audio output device** — Electron plays to the OS default sink. Verify
   the machine's output device/volume isn't muted or routed to a dead device
   (other app audio audible?). `play()` resolving (it does here) means the app did
   its part; silence after that is an output-routing/hardware issue, not the app.
3. **The ~1-2s cold-start window is now fixed** — toggling immediately on launch
   works; you no longer need to wait. If you toggled during that old gap before,
   that symptom is gone.
4. The "sound effects" master toggle is ON (it defaults OFF), and the per-sound
   `<select>` is not set to `none`.

---

## 2026-06-09 — BUGFIX: to-dos weren't persisted (lost on reload/restart)

**The bug.** "To-dos" (the per-terminal record of completed Claude turns, shown in
the To-dos / completions panel) vanished on every reload/restart.

**Root cause.** `CompletionManager` held completions ONLY in an in-memory
`this.completionItems = new Map()`. Nothing ever wrote them to disk and nothing
loaded them back, so a fresh renderer always started empty. (The codebase still had
unused `api-client.js` methods pointing at a `/todos/items/` backend, but that
Django app was deliberately removed — `INSTALLED_APPS` and `urls.py` no longer have
it — so those calls would 404. Persisting there would mean resurrecting a deleted
app.)

**The fix (right layer = the app's existing local store).** Persist completions to
the same `electron-store`-backed unified store that already holds `messages`,
`messageHistory`, and `settings` — i.e. the app's local "database". Added:
- `unified-store.js`: a `completions` array in the schema + `getCompletions` /
  `saveCompletions` (capped to the 500 most recent) / `clearCompletions`.
- `main.js`: `db-get-completions` / `db-save-completions` / `db-clear-completions`
  IPC handlers.
- `CompletionManager`: takes the ipc wrapper; `persistCompletions()` (debounced
  250ms, serializes a JSON-safe view that drops live timer handles) is called on
  every record/create/status-change/summary; `loadPersistedCompletions()` rehydrates
  the Map and re-renders oldest-first on startup, and bumps the id counter past the
  restored max to avoid collisions.
- `renderer.js`: passes `ipcHandler` into `CompletionManager` and calls
  `loadPersistedCompletions()` during `finalizeInitialization()`.

**Why local store, not Postgres.** The backend `todos` app was intentionally
deleted, and every other client-side record (messages, history, settings) already
lives in the unified store. Matching that keeps one persistence path and needs no
backend/Docker round-trip. (Switching to Postgres later would mean re-adding the
Django app — a larger product decision, not a bugfix.)

**How verified (live, across an ACTUAL restart).** Recorded a hook completion via
`completion:recorded` → it appeared in `#todo-list` AND `db-get-completions`
returned it. **Quit the app, relaunched it**, and the same to-do was back in
`#todo-list` and in `completionItems` (map size 1, mark present). Test data was
cleared afterward so the real store stays clean.

**Restart needed?** The fix takes effect on relaunch (main IPC + renderer load at
startup). Once running this branch, to-dos persist continuously — no restart needed
between sessions, that's the whole point.

---

## 2026-06-09 — BUGFIX: sound test buttons + dropdowns stayed unclickable after enabling

**Symptom (precise repro).** In Settings, after checking the "Sound Effects" enable
checkbox, the three sound `<select>`s and "Test" buttons stayed non-interactive —
they behaved as if still disabled and never responded to mouse clicks. This is the
*real* defect behind the long-running "sound is broken" reports, and the prior pass
([above](#2026-06-09--sound-effects-close-the-cold-start-gap--delete-a-broken-duplicate-path))
missed it.

**Why the prior pass missed it.** That pass verified the test buttons by calling
`button.click()` in a Playwright probe. Programmatic `.click()` (and dispatched
events) fire a handler *regardless of `pointer-events`* — CSS `pointer-events: none`
only blocks real pointer hit-testing, not synthetic clicks. So the probe reported
"buttons fire" while a real user's mouse was still blocked. The probe tested the
handler, not the gate.

**Root cause.** `style.css` gates the whole group on a class:
```css
#sound-selection-group        { opacity: .5; pointer-events: none; }
#sound-selection-group.enabled{ opacity: 1;  pointer-events: auto; }
```
But the renderer's `reflectSoundGroup(on)` only set inline
`soundGroup.style.opacity` and **never added/removed the `.enabled` class**.
Nothing anywhere toggled `.enabled`. So `pointer-events: none` always won and every
select/test button was permanently unclickable; checking the box merely changed the
dimming, which *looked* like it should have enabled them.

**The fix (one line, in `renderer.js`).** Make `reflectSoundGroup` toggle the class
the CSS actually keys on instead of poking inline opacity:
```js
const reflectSoundGroup = (on) => { if (soundGroup) soundGroup.classList.toggle('enabled', !!on); };
```
The CSS rule already handles both the opacity and the `pointer-events` flip, so the
class is the single correct switch. Runs on init (reflecting the persisted state)
and on every checkbox `change`.

**How verified (live, real gate not synthetic click).** Playwright probe against the
running app: with the checkbox OFF, `getComputedStyle('#sound-selection-group')
.pointerEvents === 'none'` and no `.enabled` class; after dispatching the checkbox
`change` ON, `pointerEvents === 'auto'`, the `.enabled` class is present, the
20-file dropdown is populated, and the test button's handler fires. The
`pointer-events` computed-value check is the true test of whether a real mouse click
would land — that's what the prior pass failed to assert.

**Restart needed?** Yes — sound wiring lives in the renderer, loaded once at
startup. Quit and relaunch onto this branch (rebuild if packaged) for the fix to
take effect.

---

## 2026-06-09 — BUGFIX: message history was invisible, not loaded, and clobbered

**Symptom.** The message-history feature didn't work: the history modal never
opened, and even when reached the list was empty across reloads/restarts.

**Three independent defects (all on the path to "history works"):**

**1 — Modal had no wiring.** `index.html` had the full markup (`#message-history-btn`,
`#message-history-modal`, `#clear-history-btn`, `#history-list`) and MQM kept a
`BoundedArray` of history, but nothing in the renderer opened the modal or rendered
the list — so history was structurally invisible. **Fix (`renderer.js`):** wire
open/close/backdrop-click/clear and a `renderHistory()` that lists items newest-first
(terminal + timestamp meta, `textContent` body = XSS-safe), plus a live refresh on
`message:history-updated` while the modal is open.

**2 — Persisted but never loaded back.** `saveToMessageHistory()` (called on every
injection) pushed to the in-memory array, but nothing wrote it to disk and
`MQM.loadMessageHistory()` was never called at startup. **Fix:** `persistMessageHistory()`
writes to the unified store (`db-set-setting 'messageHistory'`, same channel/pattern
the queue uses) on every record/clear; `renderer.js` calls
`messageQueueManager.loadMessageHistory()` right after `restoreQueue()` in
`finalizeInitialization()`. Note the store round-trips a `JSON.stringify`'d array
back as a *parsed array* (electron-store deserializes), so both load paths use the
`typeof raw === 'string' ? JSON.parse(raw) : raw` guard — identical to `restoreQueue`.

**3 — A second writer clobbered it.** `PreferenceManager` had its own
`loadMessageHistory`/`saveMessageHistory` for the *same* `messageHistory` store key,
capped at 100 and fed from a `preferences.messageHistory` copy that was loaded once
at startup and never updated as messages injected. On settings import
(`saveAllPreferences`) it wrote that stale copy back, wiping the session's messages.
Its `messageHistory:loaded` event had no listeners (dead path). **Fix:** removed
PreferenceManager's load/save of `messageHistory` entirely; `MessageQueueManager` is
now the sole owner of that key.

**How verified (live, Playwright against the running app).** Recorded a marked item
via `saveToMessageHistory` → present in memory; opened the modal via its button →
modal `show` + the item rendered in `#history-list`; read it back from the store;
wiped the in-memory array and called `loadMessageHistory()` → the item came back
(true persistence proof, not just a same-session read); `clearMessageHistory()` →
gone from both the store and the list. Test data cleared afterward.

**Restart needed?** Yes — renderer wiring + the startup history load take effect on
relaunch. After that, history persists continuously.

---

## 2026-06-09 — BUGFIX: Shift+wheel didn't scroll the terminal grid horizontally

**Symptom.** Holding Shift and scrolling the mouse wheel over the terminal grid did
nothing — there was no way to page horizontally through terminal chunks with the
wheel.

**Two root causes (both had to be fixed):**

**1 — xterm swallowed the wheel event.** The grid (`#terminals-container`, the
`layout-scroll` flex container with `overflow-x: auto`) is horizontally scrollable
when there's more than one chunk, but a wheel event over a terminal is consumed by
xterm's own scrollback handler and never bubbles to the container. **Fix:** a
**capture-phase** `wheel` listener on the container (registered once in
`setupEventListeners`) with `{ passive: false, capture: true }`. Capture runs the
container's handler before xterm's (which sits on a descendant), and `stopPropagation`
+ `preventDefault` keep the gesture from reaching the terminal. Guarded on
`e.shiftKey` and on the grid actually being horizontally scrollable
(`scrollWidth > clientWidth`), so it's a no-op otherwise and plain wheels are
untouched.

**2 — `scroll-snap` ate sub-page nudges.** First attempt did
`scrollLeft += e.deltaY`. That visibly fired (preventDefault ran) but the grid never
moved, because the container has `scroll-snap-type: x mandatory` with each chunk a
full-width (100%) snap point — any scrollLeft that isn't on a snap boundary snaps
straight back to the nearest one (verified live: `scrollLeft = 200` → reads back `0`;
`scrollLeft = clientWidth` → sticks). **Fix:** advance a whole **page** per gesture —
`scrollBy({ left: sign(delta) * clientWidth, behavior: 'smooth' })` — which lands
exactly on the adjacent chunk's snap point. Throttled to one page per 350ms
(via `e.timeStamp`) so a single wheel gesture's momentum doesn't skip several pages.

**How verified (live, TRUSTED wheel via Playwright mouse/keyboard).** Spawned 6
terminals (chunk size 4 → multiple chunks → `scrollWidth 2249 > clientWidth 749`),
moved the pointer over a terminal, held Shift: wheel forward paged `scrollLeft` 0 →
750 (one snap-aligned page); wheel back returned it to 0; a plain (no-Shift) wheel
left the grid scroll at its snap point unchanged. Note: synthetic
`new WheelEvent({deltaY})` does **not** carry usable deltas here — a real
`page.mouse.wheel` was required to exercise this honestly.

**Restart needed?** Yes — the listener is wired once at renderer startup.

---

## 2026-06-09 — BUGFIX: todo output panel always said "No terminal output available"

**Symptom.** Every todo item's output (shown in the completion-details modal) read
"No terminal output available", even when that terminal had output.

**Root cause.** `CompletionManager` fetches a terminal's live data through a
synchronous request/callback event — `this.eventBus.emit('completion:request:terminalData',
{ terminalId, callback })` — in both `recordHookCompletion` and
`displayCompletionOutput`. **Nothing in the renderer listened for that event**, so the
callback was never invoked and `terminalData` stayed `null`. `displayCompletionOutput`
then hit its `if (!terminalData)` branch → "No terminal output available" every time
(and the todo's colour/name fell back to defaults). Confirmed by grepping: only
`emit('completion:request:terminalData', …)` existed, zero `.on(...)`.

**Fix (`renderer.js`).** Register the missing provider next to the other terminal
eventBus listeners. It resolves the terminal from the state store and answers the
callback synchronously (EventBus dispatch is synchronous, same pattern as
`preference:get`):
```js
this.eventBus.on('completion:request:terminalData', ({ terminalId, callback }) => {
    if (typeof callback !== 'function') return;
    const t = this.terminalStateManager.getTerminal(parseInt(terminalId, 10));
    if (!t) return;
    callback({ lastOutput: t.lastOutput || '', color: t.color || this.getTerminalColor(terminalId),
               name: t.title || `Terminal ${terminalId}` });
});
```
`displayCompletionOutput` already extracts the text between `⏺` and `╭` from
`lastOutput` — it just never received any data to extract from.

**How verified (live, Playwright).** Created a terminal, set its `lastOutput` to
`…⏺ Hello output line 1\n  line 2\n╭…`, fired a `completion:recorded` hook, opened the
todo's modal → output panel showed **"Hello output line 1  line 2"** (the extracted
text) instead of the "No terminal output available" placeholder. Test data cleared.

**Restart needed?** Yes — the listener is wired once at renderer startup.

---

## 2026-06-09 — BUGFIX: todo "#N" badge always showed "#0"

**Symptom.** The top-right badge on every todo item read "#0", never a real value.

**Root cause.** `renderCompletionItem` rendered
`<span class="completion-prompt-number">#${completionItem.promptNumber}</span>`, and
`promptNumber` was set from `terminalData?.promptCount`. But (a) the `terminalData`
callback never fired (see the output-panel bug above) and, more fundamentally,
(b) **`promptCount` does not exist anywhere in the codebase** — the terminal state
object has no such field, so even with the callback wired the badge would still be 0.
There was no real data source behind the badge.

**Fix (`CompletionManager.renderCompletionItem`).** Render the value the item actually
carries and that the user asked for — the **terminal id** —
`#${completionItem.terminalId}`. It's always present (set at creation and persisted by
`_serializeCompletion`), so the badge now identifies which terminal each todo belongs
to. (Reviving a real per-terminal "prompt count" would be a new feature with no
existing source; the terminal id is the meaningful identifier we have.)

**How verified (live, Playwright).** Spawned several terminals, fired a hook completion
for a non-1 terminal (id 7), and read the badge → **"#7"**, matching the item's
`dataset.terminal`, instead of "#0". Test data cleared.

**Restart needed?** Yes — renderer code loads once at startup.

---

## 2026-06-09 — BUGFIX: todo "set X ago" timer was frozen at "0m 0s"

**Symptom.** Every todo's elapsed timer read "0m 0s" and never advanced.

**Root cause.** `renderCompletionItem` hardcodes `<span class="completion-timer">0m 0s
</span>`, and the only code that updated it was the per-item interval in
`startCompletionMonitoring`, which (a) is started **only** by `createCompletionItem`
(the in-progress path) and (b) ticks **only while `status === 'in-progress'`**.
Hook-driven todos are created by `recordHookCompletion` with `status: 'completed'` and
never call `startCompletionMonitoring`, and restored todos aren't monitored either —
so nothing ever wrote their timer and it stayed at the literal "0m 0s". (The separate
`completion-timer.js` / `CompletionTimerManager` is dead code — the global
`completionTimerManager` it guards on is never instantiated.)

**Fix (`CompletionManager`).** Added one shared 1-second ticker (`startElapsedTicker`
in the constructor → `updateElapsedTimers`) that drives **every** rendered todo from
its own `startTime`: it writes `now − startTime` as "Xm Ys" to each item's
`.completion-timer`, so completed hook items and restored items all count up live
("set X ago"). `renderCompletionItem` also seeds the value immediately on render
(restored items have a past `startTime`, so the hardcoded "0m 0s" would otherwise be
wrong until the next tick). `startTime` is already persisted by `_serializeCompletion`,
so restored items show the correct age.

**How verified (live, Playwright).** Fresh hook todo: "0m 0s" → after ~3.2s → "0m 3s"
(advancing). Backdated an item's `startTime` by 125s and forced a tick → seeded
**"2m 5s"** immediately, then advanced to "2m 6s" after ~2.5s. Test data cleared.

**Restart needed?** Yes — renderer code loads once at startup.

---

## 2026-06-10 — BUGFIX: voice button recorded but every transcription failed (400)

**Symptom.** Clicking the mic button started/stopped recording normally, but every
attempt ended in "❌ Transcription failed" and no text ever reached the message input.

**Root cause.** Form-field name mismatch on the upload. `VoiceManager.transcribeAudio`
posted the blob as `formData.append('audio', …)`, but the backend's
`AudioUploadSerializer` (backend/voice_transcription/serializers.py) declares
`audio_file = serializers.FileField()` — so Django rejected every request with
`400 {"audio_file": ["No file was submitted."]}`. The button, recording flow, event
wiring, health check, and backend endpoint were all fine.

**Fix (`src/features/VoiceManager.js`).** Renamed the form field to `audio_file` to
match the serializer.

**How verified (live, Playwright + fake media device).** Launched the app with
`--use-fake-device-for-media-stream`, clicked the voice button, recorded ~3s, stopped.
Before: 400 "No file was submitted". After: upload accepted, Whisper ran, pipeline
completed with "⚠️ No speech detected" (the fake device emits a tone, not speech) and
the button returned to ready — the full happy path now works.

**Restart needed?** Yes — renderer code loads once at startup.

---

## 2026-06-10 — BUGFIX: terminal 1's saved name never showed after restart

**Symptom.** Renaming terminal 1 worked for the session, but after a restart the
header showed "Terminal 1" again (the store actually held the custom name — e.g. a
long-saved "Lyra" was sitting in `terminalMetadata`, never displayed).

**Root cause.** `createTerminal()` (renderer.js) reuses the static terminal-1 wrapper
shipped in index.html instead of building chrome. That reuse branch synced only the
color dot from restored metadata; the dynamic-wrapper branch sets
`.terminal-title.textContent` but the reuse branch never did, so the static
"Terminal 1" text was left in place while the state manager (and persistence) carried
the real name. Save was never the problem — restore-to-DOM was.

**Fix (`renderer.js`, createTerminal static-wrapper branch).** Sync the title too:
set the wrapper's `.terminal-title` text from `options.title` when provided,
mirroring the dynamic branch.

**How verified (live, Playwright, two sessions).** Renamed terminal 1 via
`setTerminalMetadata(1, {title})`, closed the app, relaunched: DOM title and state
manager both showed the new name. Original name restored afterward.

**Restart needed?** Yes — renderer code loads once at startup.

---

## 2026-06-10 — CHANGE: two message types only; 'normal' no longer waits on 'running'

**Request.** Remove the 'important' priority; keep 'urgent' and 'normal'. Normal's
send condition: destination terminal isn't 'prompted' AND the auto-inject timer
isn't running (or is at 0). The 'running' state is finnicky and gets stuck, so its
role in the normal-inject gate is removed (the underlying running-state bug is
deliberately NOT fixed here).

**Exact new condition.** `normal` injects iff `terminal.status !== 'prompted'` AND
`!timerManager.isRunning()` — `isRunning()` is already false when the countdown is
stopped, paused, or expired at 0, which matches "isn't running or not at 0". The
usage-limit, paused (master send toggle), and bare-shell guards are unchanged and
still apply to both types. `urgent` is unchanged: jumps to the queue front and
bypasses the status gate (but never the bare-shell guard).

**Changes.**
- `src/messaging/injection-gate.js` — status gate now blocks non-urgent only on
  'prompted'; 'running' no longer gates. 'important' bypass removed.
- `src/messaging/MessageQueueManager.js` — `VALID_TYPES = ['normal','urgent']`
  (legacy/API 'important' coerces to 'normal' via normalizeType, so stale queue
  items and control-API callers degrade gracefully); queue badge now urgent-only;
  "Mark important" menu option removed; comments updated.
- `renderer.js` / `index.html` / `style.css` — Important removed from the input-bar
  priority selector (UI shows Normal/Urgent only).
- `src/main/manager-session.js` — manager control-API docs rewritten for the
  two-type system and the new normal condition.
- `src/messaging/injection-gate.test.js` — updated; 9/9 pass, including a new
  legacy-'important'-gets-no-bypass case.

**How verified (live, Playwright + node --test).** In the running app:
priority menu = [normal, urgent]; normalizeType('important') → 'normal';
normal while status 'running' → allowed; while 'prompted' → blocked
("terminal 1 is prompted"); while a 60s countdown armed → blocked ("timer still
counting down"); after stopping the timer → allowed. urgent allowed while
'prompted'. All 9 injection-gate unit tests pass.

**Restart needed?** Yes — renderer code loads once at startup. The manager's
CLAUDE.md template only applies to newly-written manager directories; an existing
manager dir keeps its old doc text until regenerated.

---

## 2026-06-10 — voice: real processing spinner + microphone device picker

**Symptoms.** (1) While a recording was being transcribed, the whole mic button
(icon included) rotated — the `.processing` CSS applied `animation:
processing-spin` to the button element itself. (2) Recordings came back silent
for users whose system-default input isn't the real microphone, and there was no
way to choose the input device.

**Fixes.**
- `style.css` — `.processing` no longer rotates the button. The mic icon (svg) is
  hidden in that state and a dedicated circular `::after` spinner ring takes its
  place (reuses the previously-unused `processing-spin-circle` keyframes; the old
  whole-button `processing-spin` keyframes are deleted).
- Microphone picker: new "Microphone" select in the settings modal
  (`#microphone-select`, index.html). `renderer.js` repopulates it on every
  settings open via `enumerateDevices()` (a throwaway `getUserMedia` first, so
  device labels are exposed); changes persist as the `microphoneDeviceId`
  preference (PreferenceManager default: `'default'`).
- `src/features/VoiceManager.js` — picks the persisted device up on load
  (`preferences:applied`) and live (`preference:changed`); records with
  `deviceId: { exact: … }`, falling back to the system default (with a warning in
  the action log) if the saved device is unplugged/stale. Also logs
  "🎙️ Using microphone: <label>" at record start so a wrong-input capture is
  visible immediately.

**How verified (live, Playwright + fake media devices).** During processing the
button's computed `animation-name` is `none`, the svg is `display:none`, and the
`::after` pseudo-element spins with `processing-spin-circle` at 50% border-radius
(a circle). Settings shows "System default" + "Fake Audio Input 1/2" with labels;
selecting one updates `voiceManager.microphoneDeviceId` and the preference, and
`buildAudioConstraints()` yields `{deviceId:{exact:…}}`. After an app restart the
saved device is restored onto VoiceManager (also proven with a marker id via
`db-get-setting` round-trip). Probe reset the setting to 'default' afterward.

**Restart needed?** Yes — renderer/CSS load once at startup.

---

## 2026-06-10 — voice: spinner escaped the button; silent recordings now diagnosed

**Symptoms.** (1) The processing spinner rendered OUTSIDE the mic button (above
it) while the button itself went flat blue. (2) Real-mic recordings kept ending
in "No speech detected" with no way to tell whether the mic captured anything.

**Root cause (spinner).** `#voice-btn` carries `.hotkey-enabled`, whose hotkey
tooltip ALSO styles `::after` (`position:absolute; bottom:100%`, blue pill
background, hover opacity). The spinner rule only set the properties it needed,
so the tooltip's positioning/background bled through the cascade and the ring
ended up above the button. Fix: the processing `::after` now pins every
layout/visual property (absolute, top/left 50%, margin-centered — not
transform-centered, since the spin animation owns `transform`) and the
tooltip's `::before` arrow is suppressed during processing.

**Silent-recording diagnostics (`VoiceManager`).** A WebAudio analyser now
meters the live input during recording and tracks the peak level:
- peak < 1% → the upload is skipped and the action log states the capture was
  silent, naming the device ("🔇 ... from <label>. Pick a different input in
  Settings → Microphone, or check OS input volume/mute.")
- otherwise the peak is logged ("🎚️ Recording peak input level: N%") so a
  too-quiet mic is visible even when Whisper finds no words.
Uploads are also now named by their real container (`recording.webm`/`ogg`/...,
from the MediaRecorder mime type) instead of a fake `recording.wav`, so the
backend's temp-file suffix matches the actual bytes.

**How verified (live, Playwright + fake media device).** During processing the
`::after` computed style is absolute at top/left 13px with -7px margins (dead
center of the 30px button), transparent background, opacity 1, spinning
`processing-spin-circle`; `::before` is display:none; an element screenshot
shows the white ring inside the blue circular button. Action log for a 2.5s
fake-device recording: "🎙️ Using microphone: Fake Default Audio Input" →
"🎚️ Recording peak input level: 93%" → (tone, not speech) "No speech detected".

**Restart needed?** Yes.

---

## 2026-06-16 — Urgent messages actually send + queue control features

**Why urgent messages were silently vanishing.** Two independent defects, both
fixed:

1. **The control API dropped the `type` field.** `POST /queue/add {type:"urgent"}`
   was ignored — `HookServer.onQueueAdd` only forwarded `{terminalId, content}`,
   and the renderer's `queue-add-request` handler likewise omitted `type`. So an
   externally-queued message always inherited the UI's `selectedMessageType`
   (normal), never the caller's. Now `HookServer` validates the incoming `type`
   against the allowed set (`HookServer.normalizeQueueType`, mirroring
   `MessageQueueManager.VALID_TYPES = ['normal','urgent']`, default `normal`) and
   forwards it; the renderer reads `type` and passes it to `addMessage`. The
   canonical validator stays `MessageQueueManager.normalizeType`, which runs again
   in the renderer.

2. **Urgent didn't bypass the bare-shell guard.** A terminal SSH'd into a remote
   machine running Claude is detected *locally* as `runtime:'shell'` (no local
   `claude` process in `/proc`), so the injection gate's bare-shell guard ate
   urgent messages bound for that remote session. Per "urgent must send regardless
   of any condition," `evaluateInjectionGate` now lets `messageType === 'urgent'`
   bypass **every** gate — usage-limit, timer, paused, bare-shell, and the
   prompted-status gate. The ONLY remaining hard block for urgent is a missing
   target terminal (`terminalId == null` — nothing to inject into). Every gate is
   left fully intact for `normal`. The accepted trade-off: an urgent prompt could
   land in a genuine bare bash; that's acceptable because urgent is an explicit
   human/manager override. Tests in `injection-gate.test.js` were updated (normal-
   into-shell still blocked; urgent-into-shell now allowed) and extended (urgent
   overrides each gate individually and all at once; urgent still blocked with no
   target).

**Instant-send endpoint (force inject now).** New control route
`POST /queue/inject-now {messageId}` → `HookServer.CONTROL_ROUTES['/queue/inject-now']`
→ main forwards it → renderer's `handleControlRequest('queue-inject-now')` calls
`MessageQueueManager.injectMessageNow`, which types straight to the PTY via
`_injectToTerminal` and bypasses the pause/timer/usage-limit gate. A dedicated
per-message "Send now" button was added to each queue row (alongside the existing
"Send immediately" menu item).

**Retarget a queued message.** `POST /queue/update` now also accepts `terminalId`
to move a queued message to a different destination. `applyControlUpdate`
validates the target exists (`terminalStateManager.getTerminal`) before moving it,
so a typo'd id can't strand the message on a phantom terminal; combinable with
`content`/`type`. The queue menu gained "Move to <terminal>" options listing every
known terminal except the message's current one (and excluding the manager).

**Copy text out of a terminal pane (human UI).** Right-clicking a terminal now
shows a small context menu with "Copy selection" (xterm `getSelection`) and "Copy
visible buffer" (reads the viewport lines via `buffer.getLine`/`translateToString`),
writing to the clipboard via `navigator.clipboard`. Action-log feedback reports how
many chars were copied.

**Verification.** Pure-module unit tests: `injection-gate.test.js` (12) and the new
`HookServer.test.js` (3) all pass; the related `timer-expiry-resume`,
`usage-limit-resume`, and `pty-control` suites (20) still pass. `node --check`
clean on `renderer.js`, `MessageQueueManager.js`, `HookServer.js`.

**Restart needed?** Yes — changes touch the main process (`HookServer.js`) and
`renderer.js`, which only take effect after the Electron app is restarted. A human
must run it (a restart kills all terminals including the manager): `./start.sh`.

---

## 2026-06-16 — Manager role template updated to v4 (orchestrator doctrine)

**Why.** The manager's role doc (`MANAGER_CLAUDE_MD` in `src/main/manager-session.js`)
is the template stamped into every manager directory's `CLAUDE.md`. The manager rewrote
its own canonical doc at `/media/ethan/smalls/claude-manager/CLAUDE.md` (now versioned
`v4`) to make the manager a pure **engineering orchestrator** — it plans, delegates,
and reviews but does NO implementation itself.

**What changed.** The body of the `MANAGER_CLAUDE_MD` template literal now reproduces
that v4 source file verbatim (everything after the marker line), and `MANAGER_MD_VERSION`
was bumped `v3 → v4` so `ensureManagerClaudeMd` refreshes existing manager directories
on next boot instead of leaving a stale doc. The literal still begins with the
interpolated `${MANAGER_MD_MARKER}` (the `<!-- ccbot-manager-md:v4 -->` comment is
produced by interpolation, not hardcoded). The embedded markdown was escaped for the
template literal (backslashes doubled for the curl line-continuations, backticks
escaped; no `${...}` occur in the doc, and `$CCBOT_PORT`/`$CCBOT_TOKEN` need no
escaping as they have no brace).

**Most important new content preserved:** the section "## The One Hard Rule — You Do
NOT Touch Projects" — the manager makes no code changes ever, delegates everything
outside its own directory to terminals it stands up, and its sole role is keeping
those sessions unblocked and meeting acceptance criteria. The doc also documents the
new `/queue/inject-now` and `terminalId`-retarget endpoints shipped in the prior entry.

**How verified.** Generated the literal programmatically and confirmed the rendered
string is byte-for-byte identical to the source file (`rendered === source: true`).
`node -e "require('./src/main/manager-session.js')"` loads cleanly; `node --check`
passes.

**Restart needed?** Yes — `manager-session.js` runs in the main process, and the
refreshed doc is only written when the manager next boots, which happens on app start.

---

## Discord voice bridge — talk to the manager (999) from a Discord voice channel

**Date:** 2026-06-26. **Branch:** dev. **Scope:** new, fully self-contained
service under `discord-bridge/`. **Nothing in the running Electron app, the
manager PTY, or the backend was modified or restarted** — this is purely
additive and reaches the app only through the documented loopback control API.

**Goal.** Let the user join a Discord voice channel (e.g. from their phone, away
from the house), speak, and have that reach the manager terminal 999 as a framed
voice memo; the manager's spoken TTS replies play back into the same channel.

**What was built.** A standalone Node (CommonJS) process in `discord-bridge/`:
- `config.js` — loads `.env` + inherits `CCBOT_PORT`/`CCBOT_TOKEN` from the
  launching app terminal; validates; exposes the 🎙️ voice-memo marker.
- OUTPUT (manager → channel): `src/ttsPoller.js` polls
  `GET /api/tts/notifications/?after=<lastId>&limit=50`, **seeds `lastId` from
  the newest row on startup so history is never replayed**, downloads each new
  `audio_url` WAV, and hands it to `src/audioPlayer.js` (a FIFO
  `@discordjs/voice` player, ffmpeg-transcoded). Optionally marks `…/played/`.
- INPUT (channel → 999): `src/voiceReceive.js` captures each speaker's Opus via
  `VoiceReceiver` (silence-gap utterance segmentation + a min-duration gate to
  drop clicks), decodes to PCM (`prism-media`), wraps as WAV (`src/wav.js`),
  transcribes via the app's existing Whisper endpoint
  `POST /api/voice/transcribe/` (field `audio_file`), then delivers the text to
  terminal 999 via `POST /terminal/keys` (`src/controlApi.js`). That path has
  **no 999 block** (unlike `/queue/add`). The memo is framed with the literal
  marker the manager's CLAUDE.md watches for, and multi-line memos are wrapped in
  bracketed-paste (`ESC[200~ … ESC[201~`) + trailing Enter so they don't submit
  early in Claude's TUI.
- `src/dave.js` (DAVE presence check), `src/log.js` (stdout + optional mirror to
  the app's unified `[frontend]`/`[discord-bridge]` log stream), `src/doctor.js`
  (no-token preflight), `run.sh`, `README.md`, `SETUP.md`, and
  `python-receiver/README.md` (fallback notes).

**DAVE (mandatory E2EE voice since March 2026) — the load-bearing decision.**
Researched against primary sources. Pinned `@discordjs/voice@^0.19.2`
**on purpose**: PR #11449 (merged 2026-03-13, shipped 0.19.2) fixes the DAVE
voice-**receive** bug (RFC3550 padding not stripped → garbled/zero capture);
0.19.0/0.19.1 receive is broken. `@snazzah/davey` (0.1.12) auto-installs as a
hard dep of voice — no manual wiring; playback under DAVE is maintainer-confirmed
working. The Python path (`discord.py 2.7.1` + `discord-ext-voice-recv`) is NOT
viable as a drop-in: that extension doesn't decrypt DAVE (issue #53 open, fix
PR #54 unmerged), so Node is the only reliable receive path today.

**Double-audio note.** The in-app NotificationManager also plays each TTS clip.
Documented fix: toggle the app's mute button (`#notification-mute-btn`,
persisted `notificationsMuted`) — it silences only the local HTMLAudioElement;
the backend notification feed the bridge polls is unaffected. No restart, no
lost messages.

**How verified (without a live Discord token).**
- `npm install` clean (106 pkgs); all native deps load on Node 20
  (`@discordjs/voice`, `@discordjs/opus`, `sodium-native`, `prism-media`,
  `ffmpeg-static`, `@snazzah/davey` v0.1.12).
- `node src/doctor.js`: backend TTS endpoint reachable; control API `/state`
  reachable with manager 999 present (status running); CCBOT creds inherited.
- INPUT pieces (no keys sent to 999): framing + bracketed-paste keys array
  correct; `POST /api/voice/transcribe/` multipart round-trip returns HTTP 200
  on Node 20 (silence → empty text, as expected).
- OUTPUT data path: poller seed correctly skips history; rewinding lastId by 1
  downloads a real 1.19 MB WAV from the backend (backend state untouched —
  `markPlayed` stubbed in the test).
- `node --check` passes for every JS file; `bash -n run.sh` clean.

**Known runtime note.** `@discordjs/voice@0.19.2` declares `engines.node
>=22.12.0`. All modules load and the non-voice paths verify on the system's
Node 20; SETUP.md recommends Node 22+ for the live voice run.

**Still needed to go live (handed to user in SETUP.md):** a Discord bot token,
guild ID, and voice channel ID. Acceptance (bot joins channel; manager TTS plays
in; user speech reaches 999 as a framed memo; app never restarted) is verified
end-to-end only after the user provides the token.

**Restart needed?** No. The bridge is a separate process; the Electron app and
manager were never touched.

### Discord bridge enhancement — system-audio capture (hear EVERYTHING, not just TTS)

**Date:** 2026-06-26. **Branch:** dev. **Still uncommitted** (per user: nothing
commits until the live token test passes). Additive to `discord-bridge/`.

**Why.** TTS-notification polling only catches TTS clips, so a remote user would
miss system sound effects, chimes, and especially the morning **wake-up song**
(plays via mpv straight to the sink, not through the notification feed).

**What.** New `AUDIO_SOURCE` flag:
- `tts` (default) — existing behavior: poll the notification feed, play TTS only.
- `system` — capture the machine's audio OUTPUT (the default sink's `.monitor`)
  and stream it into the channel, so the remote user hears *everything* the
  speakers play. In this mode the TTS poller is **auto-disabled** (the monitor
  already contains the TTS audio → no double-play).

**Implementation.** `src/systemAudio.js`: `parec` captures
`<default-sink>.monitor` as 48kHz/stereo/s16le (Discord-ready `StreamType.Raw`),
fed to a new `VoicePlayer.playLive()` continuous resource. Because PipeWire
**suspends idle sinks** (verified: a suspended sink's monitor emits no data), a
silent **keepalive** (`pacat < /dev/zero` into the sink) keeps it warm so the
monitor is continuous. Both children auto-restart on exit; `stop()` kills both.
Device auto-resolves via `pactl get-default-sink` (override:
`SYSTEM_AUDIO_DEVICE`); socket from `PULSE_SERVER` (default `/run/user/<uid>/pulse/native`).
Config: `AUDIO_SOURCE`, `PULSE_SERVER`, `SYSTEM_AUDIO_DEVICE`,
`SYSTEM_AUDIO_KEEPALIVE`, `SYSTEM_AUDIO_WARMUP_MS`.

**Muting interaction (documented in SETUP.md).** Opposite rules per mode:
`tts` mode → MUTE in-app playback (bridge polls backend independently). `system`
mode → do NOT mute (audio must reach the sink to be captured).

**How verified (no Discord token needed).**
- Probed env: PipeWire 1.0.3 (PulseAudio compat), uid 1000, socket present,
  `parec`/`pacat`/`pactl` present, default sink monitor RUNNING.
- Proved the idle-suspend problem empirically: raw monitor capture yielded 0
  bytes when idle, ~2s only while a beep played.
- Proved the keepalive fix: warmed sink + low-latency parec → **4.98s of
  continuous PCM in a 5s window**.
- Module smoke test (`SystemAudioCapture` through real code): `onStream` fired,
  **3.27s continuous PCM in a 3.3s window** with no real audio playing; clean
  `stop()` left **no orphan parec/pacat processes**.
- `doctor.js` in system mode: all tool/socket/device checks green, monitor
  resolves to `alsa_output.pci-0000_11_00.6.analog-stereo.monitor`.
- All `node --check` pass.

**Still unverified (needs live token):** the captured stream actually arriving in
the Discord channel under DAVE, and the wake-up alarm being audible remotely —
both part of the live test.

### Discord bridge — major re-architecture: standalone service + rotatable session-key link + wake word

**Date:** 2026-06-26. **Branch:** dev. **Still uncommitted** (no commit until the
live token test). Reworks `discord-bridge/` from a terminal-bound TTS relay into a
persistent, linkable, wake-word voice assistant.

**1) Standalone persistent service.** The bot no longer depends on the
discord-bridge terminal or the Electron app's lifecycle. `service/install.sh`
installs a `systemd --user` unit (`ccbot-discord-bridge.service`, auto-restart,
optional `--boot` enable-linger), `uninstall.sh` removes it. The service holds
**no app credentials at rest** and idles until linked, so it survives the
auto-injector app restarting. (`systemd-analyze verify` clean after moving
`StartLimitIntervalSec`/`Burst` to `[Unit]`.) `nohup` fallback documented.

**2) Rotatable, local-only session-key linking.** The bot starts UNLINKED. The
manager (terminal 999, holds live `CCBOT_PORT`/`CCBOT_TOKEN`) runs
`npm run link-key` (`tools/make-link-key.js`): mints a random revocable
**link-token**, writes the real creds + token to a `0600` vault at
`$XDG_RUNTIME_DIR/ccbot-bridge/vault.json` (loopback/tmpfs), and prints a
paste-able `/link <key>`. **The pasted key carries only `{port, link-token}` —
never the control token** — so a key leaked through Discord is useless without
local machine access. The bot resolves the key against the vault locally
(`src/linkVault.js`), validates against the live control API `/state`, and holds
creds in memory only (`src/linkManager.js`). **Rotation** = re-run the tool → new
link-token overwrites the vault → old key stops resolving; the app token never
changes. Keys expire (default 1h, `--ttl`). This honors: rotatable, decoupled
from the raw token, local-only loopback, manager-generated, START-SESSION via
`/link`.

**3) Wake word + music-bot join.** `/link` (slash command) joins the voice
channel the **invoking user is currently in** (`interaction.member.voice` —
`DISCORD_VOICE_CHANNEL_ID` is now only an optional fallback). Then only speech
beginning with the wake phrase (default "hey claude") is forwarded; the phrase is
stripped, the remainder is the prompt; saying the phrase alone arms a short
follow-up window (`src/wakeWord.js`, `src/voiceReceive.js`). Slash commands:
`/link`, `/leave`, `/status` (`src/commands.js`); requires the
`applications.commands` invite scope.

**Wake-word implementation decision (honest).** The app uses Vosk via
vosk-browser (WASM, renderer). For this Node service there is **no working native
Vosk**: the `vosk` npm depends on `ffi-napi`, which fails to build on Node 20/22
(node-gyp error, reproduced), and there's no pure-JS Vosk. Chosen path:
**Whisper-text gating** — transcribe each utterance with the app's existing local
Whisper and forward only wake-prefixed ones. Same product intent, local-only, no
native build. Trade-off (documented): every utterance is transcribed locally to
check for the wake word. The spotter interface is small so a Vosk-backed
gate (e.g. a backend endpoint) can replace it later.

**4) System-audio output retained** (TTS + sound effects + wake-up alarm), now
started per-session by `src/session.js` on link.

**5) DM-call research (non-blocking).** Confirmed: no Discord bot DM-voice-call
API and no conversational-AI voice primitive exist in mid-2026; the Social SDK is
games-only. Guild voice channel + `@discordjs/voice` remains the only path. No
architecture change.

**How verified (no Discord token).**
- All modules `require` cleanly; `node --check` passes for every file; slash
  command defs build (`link, leave, status`).
- **Full link path tested against the LIVE control API** (this terminal has real
  `CCBOT_*`): minted a key → bot resolved + validated → manager 999 reachable
  (running) → linked ✅; **rotation** re-mint correctly invalidated the old key
  ("superseded"). (No keys sent to 999 — `forward()` not called.)
- Wake spotter unit tests 6/6 (including "hey cloud" mishearing, wake-alone,
  no-wake, mid-sentence wake).
- Service wiring smoke: with a fake token the process loads everything and fails
  ONLY at Discord login (`TokenInvalid`) — all wiring sound.
- `doctor.js` green: deps, DAVE v0.1.12, backend, audio tools/monitor (system
  mode), vault detection, live control API + manager presence.
- systemd unit renders + `systemd-analyze verify` clean.

**Still needs the token (live test):** Discord login, slash-command registration
in the guild, `/link` join-current-channel, DAVE voice-receive of "hey claude"
→ forward to 999, and audio playback (TTS + system audio incl. the wake-up alarm)
into the channel.

### Discord bridge — shared CPU wake-gate (stop pegging the GPU with constant Whisper)

**Date:** 2026-06-26. **Branch:** dev. **Uncommitted; built but NOT deployed**
(bot is off + backend not rebuilt — pending the user's thermal all-clear).

**Problem.** The bridge already used the backend's *shared* Whisper (no duplicate
model in VRAM), but it transcribed EVERY captured utterance to find the wake word
— and Whisper loads on `cuda` (RTX 3090), so constant channel chatter meant
constant GPU inference, contributing to a thermal emergency.

**Fix — gate on cheap CPU before the GPU.** Added a Vosk wake-word endpoint to the
backend and made the bridge gate through it:
- **Backend:** `backend/voice_transcription/wake_service.py` (`VoskWakeService`,
  CPU, lazy-loads the app's existing `vosk-model-small-en-us` — extracts the
  shipped tarball), new `POST /api/voice/wake-check/` view + URL, `vosk==0.3.45`
  in `requirements.txt`, and a `docker-compose.yml` change mounting
  `./assets/models:/models:ro` + `VOSK_MODEL_PATH`. Vosk is CPU-only — no GPU, no
  duplicate model (reuses the desktop app's model).
- **Bridge:** `src/wakeCheck.js` posts each utterance to the CPU Vosk endpoint;
  `src/voiceReceive.js` now gates on that transcript and only calls the GPU
  Whisper (`/api/voice/transcribe/`) AFTER the wake word fires (for an accurate
  command). Idle chatter = CPU Vosk only; GPU ≈ once per real command. Flags:
  `USE_SHARED_WAKE_GATE` (default on), `COMMAND_USE_WHISPER` (default on; off =
  zero-GPU, use the Vosk transcript as the command).

**Why not local Vosk in the bot.** Native `vosk` npm won't build on Node 20/22
(`ffi-napi`); `vosk-browser` (WASM) needs browser globals (`Worker`/`AudioContext`)
so it won't run headless in Node. Centralizing Vosk in the backend (CPU) is the
clean "share the resource" answer and reuses the model the app already ships.

**Net resources:** one Whisper (backend GPU, only on wake), one Vosk (backend
CPU, the gate), zero duplicates in the bot.

**Verified (no deploy):** bot `node --check` + require-smoke clean; backend
`python -m py_compile` clean for wake_service/views/urls; `docker compose config`
valid; live wake config still mirrors the app ("sean").

**To activate (when temps are safe):** `docker compose up -d --build` (rebuilds
ONLY the backend for the `vosk` dep + model mount; never touches the Electron
app), then bring the bot back (`systemctl --user enable --now ccbot-discord-bridge`)
and `/link`. Until rebuilt, the endpoint 404s and the bridge falls back to the
Whisper gate.
