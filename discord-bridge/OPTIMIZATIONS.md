# Optimizations / Changes Log

## 2026-08-26 — Post to any channel with `--channel`, and send a draft as a FILE

Drafts written into Discord scrolled away in `#claude-voice` along with everything
else, so there was no way to go back to one and iterate on it. Two changes fix that.

- **`--channel <name>` on `tools/post-text.js`, `post-image.js` and the new
  `post-file.js`.** The named channel is looked up in the guild, created if it
  isn't there, and cached — so `--channel rma-drafts` creates `#rma-drafts` the
  first time and lands in that same channel every time after. This generalises the
  resolve-or-create the mirror already did for its one hardwired channel
  (`textMirror._doResolve`) into `textMirror.channelFor(name)`; it did not need a
  new mechanism.
- **`tools/post-file.js <path>` posts a plain-text file as a real attachment.** A
  long draft belongs in ONE file Ethan can download, edit and hand back, not spread
  across chat messages. Takes `.md`, `.txt`, `.json`, `.csv`, `.log` and friends;
  refuses anything else and anything over the 8MB cap (`TEXT_FILE_MAX_BYTES`)
  rather than posting a cut-off file. It reuses `pathGuard` for path containment
  and `AttachmentBuilder` exactly as `postImage`/`postVideo` already do.

**Names are normalised the same way on both sides** (`src/outbox.js`,
`sanitizeChannelName`): lowercase, spaces and underscores to dashes, punctuation
dropped, capped at Discord's 100 characters. `--channel "RMA Drafts"` and
`--channel rma-drafts` are the same channel, so a messier spelling can't create a
duplicate.

**Nothing fails silently any more.** The tools used to print "queued" and exit,
which looked identical whether the post landed or not. The bridge now writes a
result file next to the descriptor and the CLI waits for it and prints what
actually happened: `✅ Posted to #rma-drafts`, or a loud `⚠️ Could not use
#rma-drafts: the bot lacks Manage Channels — posted to the DEFAULT channel
#claude-voice instead`, or `❌ NOT posted: <the bridge's own reason>` with exit 1.
`--no-wait` keeps the old fire-and-forget behaviour.

**The default path is untouched.** No `--channel` means the default mirror channel,
same as before — that's the path the manager's own updates and the voice mirror
use. `postText`'s existing 2000-char chunking was deliberately left exactly as it
is; it already splits long posts across messages without losing anything, which was
mistaken for truncation. The voice mirror's `_post()` is likewise unchanged.

**Verified live.** 102/102 tests (19 new: name normalisation and its idempotence,
create-once-then-reuse including three concurrent posts, existing-channel lookup,
the no-Manage-Channels and unusable-name fallbacks, deleted-channel recovery,
default-path isolation, chunking unchanged, and the file type/size/empty refusals).
Bridge restarted on the running worktree — logged in as auto-injector#0250, text
mirror → #claude-voice. Then, live in Ethan's server: a default post landed in
`#claude-voice`; `--channel rma-drafts` created `#rma-drafts` and posted; `--channel
"RMA Drafts"` landed in the same channel; `post-file.js` delivered
`wd-rma-letter.md` (1198 bytes, `text/markdown`) as a downloadable attachment;
`post-image.js --channel` delivered a PNG there; and a post after a full bridge
restart resolved the existing channel ("existing named channel" in the log) instead
of creating another. The Discord API reports exactly one channel named
`rma-drafts`. A 12.16MB file was refused with `❌ NOT posted: t043-oversize.md is
12.16MB, over the 8MB cap — not posting a truncated file` and exit 1.

### Follow-up — post drafts from where they actually live

Using the above surfaced the real gap: `pathGuard` only allowed
`$XDG_RUNTIME_DIR/ccbot-bridge`, its inbox, and `/tmp`, so a draft kept in
`/media/ethan/smalls/claude-manager/notes/rma/` had to be **copied to `/tmp`** before
it could be posted. That leaves two copies of the same draft — the one Ethan edits
and the one the manager keeps — which drift apart the moment either is touched.

Fixed by adding that one directory as a trusted root, through the extension point
that already exists rather than by weakening the check:

```
# discord-bridge/.env
CCBOT_MEDIA_ROOTS=/media/ethan/smalls/claude-manager/notes
```

`pathGuard.allowedRoots()` already reads `CCBOT_MEDIA_ROOTS` and **adds** it to the
built-in roots, and `config.js` loads `.env` through dotenv, so the same value
reaches both the bridge (systemd `EnvironmentFile`) and the `post-*` CLI in one
place. Containment is otherwise untouched: still realpath-resolved (no symlink
escape), still regular-files-only, still deny-by-default. Verified that it now
accepts `notes/rma/*.md` while still refusing `~/.bashrc`, `/etc/passwd`, and
`claude-manager/CLAUDE.md` — a *sibling* of the new root, which confirms one
directory was added rather than the whole manager tree. Documented in
`.env.example` so a fresh setup can find the knob.

**Verified live.** Bridge restarted (pid 1259814); `CCBOT_MEDIA_ROOTS` confirmed
present in `/proc/<pid>/environ`. `post-file.js --channel rma-red` posted
`notes/rma/wd-rma-red-B01MHE9D.md` straight from its real location — no `/tmp` copy
— and it arrived in `#rma-red` as a 4335-byte `text/markdown` attachment whose
SHA-256 matches the file on disk byte for byte
(`2f4f07c5…d2a5`).

