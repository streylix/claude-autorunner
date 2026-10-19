# Terminal table-of-contents (T488) — spec + clickable mockup

**Status: design only.** Nothing in this spec has been implemented; no file outside
`docs/` was touched to produce it. See "Proof the live app is untouched" at the
bottom. Companion clickable mockup: `docs/terminal-toc-mockup.html` (screenshots
in `docs/terminal-toc-preview/`, captured locally and not committed — they
showed the live terminal list; the mockup's sample data is generic).

## 0. The ask, verbatim

> "a table of contents ... because we can have so many terminals now and
> sometimes hard when I ask to see what the terminal that I wanna see is so
> there should be a button that somehow when you click it, it opens up a
> model that lists every terminal that's out there. What's name is what it's
> color is and it status and then, if you can click one of the rows, it takes
> you to it so that way I can see which ones are running from a quick list
> instead of scrolling through each one would just be easier. Also maybe a
> filter so only filter by terminals are running or a sort by that sort by
> you know last active."

Read as: a searchable, keyboard-first list of every terminal (name, color,
status), filterable and sortable, where picking one jumps you to it.

## 1. How it opens

**Button.** `index.html:27` has `<div class="header-left"></div>` — an empty
flex spacer (`style.css:230-232`, `flex: 1`) that exists only to push
`.title` ("Auto-Injector") to the right inside the top `.header` bar
(`style.css:214-223`). It's the one piece of persistent, always-visible chrome
that isn't already tied to a specific terminal or sidebar tab, so it's the
right home for a global "Terminals" button — unlike `add-terminal-btn`
(`index.html:194`), which is duplicated once *per terminal header* and isn't a
singleton control.

Caveat that must be respected: `.header` is a drag region
(`-webkit-app-region: drag`, `style.css:222`) because the window uses
`titleBarStyle: 'hiddenInset'` (`main.js:396`, a frameless/inset macOS title
bar). Any interactive element placed inside it needs an explicit
`-webkit-app-region: no-drag`, exactly like the existing precedent at
`style.css:4495-4496` (`.remote-indicator` inside the also-draggable footer
bar, `style.css:4492`). Skipping this makes the button undraggable-through
but unclickable — it would just move the window.

**Keyboard shortcut.** Every currently-bound modifier shortcut in the app is
registered in exactly one place, `renderer.js:988-1013`
(`document.addEventListener('keydown', ...)`, gated on `e.metaKey ||
e.ctrlKey`):

```
renderer.js:994  key === 't' && !shift        → new terminal
renderer.js:995  key === 'w' && shift         → close terminal
renderer.js:1001 key === 'i' && !shift        → inject next message
renderer.js:1002 key === 'p' && !shift        → toggle timer
renderer.js:1003 key === 's' && !shift        → open settings
renderer.js:1004 key === 'm' && !shift        → manager nav
renderer.js:1005 key === 'h' && shift         → message history
renderer.js:1006 key === 'l' && shift         → clear log
renderer.js:1009 key === 'f' && (meta||shift) → terminal search
```

Two more global combos are registered separately in
`src/ui/UIFocusManager.js:284-303`:

```
UIFocusManager.js:286  Cmd/Ctrl+F → focus the log search input
UIFocusManager.js:294  Cmd/Ctrl+K → focus the terminal selector (message-target
                                    dropdown, NOT a jump-to-terminal UI — see §7)
```

`index.html` additionally *labels* (via `data-hotkey`, purely informational —
some aren't wired to any handler, e.g. Cmd+B) these combos on buttons:
`Cmd+F`, `Cmd+Shift+L`, `Cmd+T`, `Cmd+Shift+W`, `Cmd+S`, `Cmd+Shift+S`,
`Cmd+P`, `Cmd+B`, `Cmd+Shift+H`, `Cmd+I`, `Cmd+Shift+.`, `Cmd+K`,
`Cmd+Shift+V` (full list: `index.html:59,68,194,203,257,294,297,304,320,323,326,349,369`).

The full set of taken letters/combos (wired or merely labeled) is:
`t, shift+w, i, p, s, m, shift+h, shift+l, f, k, b, shift+s, shift+v, shift+.`.

**Chosen shortcut: `Cmd/Ctrl+J`.** `j` appears nowhere in that list, isn't an
Electron/macOS system-level reservation (unlike `Cmd+Q/W/N/Tab`), and reads
naturally as "jump." It's registered the same way as the existing global
combos: a new `else if` branch appended to the `keydown` handler at
`renderer.js:988-1013`.

## 2. Row contents

Each row: **color dot · id · name (title) · directory (secondary line) ·
status pill · last-active time**, plus a small muted-bell glyph when the
terminal has notifications muted. Grounding for each field:

- **Color** — `renderer.js:2534-2538` (`terminalColorFor(id)`): a per-terminal
  custom color (`state.color`, set via the color-picker modal) wins; otherwise
  `getTerminalColor(id)` (`renderer.js:2520-2527`) indexes the *actual* live
  palette at `renderer.js:149-152`:
  `['#007acc','#28ca42','#ff5f57','#ffbe2e','#af52de','#5ac8fa','#ff8c00','#00c2a8']`,
  by `(id - 1) % 8`. The manager (id `999`) is always
  `var(--accent-warning)` (`renderer.js:2521-2523,2535`).
  Note: `COLOR_PALETTE.md` documents a *different*, 24-color palette
  (`COLOR_PALETTE.md:68-79`), and `src/core/terminal-manager.js:20` has a
  *third*, 6-color one — neither is what actually renders. `renderer.js:149-152`
  is the source of truth; the mockup and spec use it, not the doc.
- **Name** — `renderer.js:2540-2543` (`terminalNameFor(id)`): `state.title`,
  falling back to `` `Terminal ${id}` ``. The manager is hardcoded `"Manager"`.
- **Id** — the terminal's numeric id as shown in `/state`'s `terminals[].id`
  and `data-terminal-id`. Manager is `999` (deliberately, not `0` —
  `main.js` treats `id 0` as falsy in places, per the `ManagerInstance` note
  in `CLAUDE.md`).
- **Directory** — `/state`'s `terminals[].directory`, sourced from
  `TerminalStateManager`'s `directory` field (`src/state/TerminalStateManager.js:35`).
  Shown small and muted under the name, the way a command palette shows a
  file's folder under its name.
- **Status pill** — see §3.
- **Last-active** — see §6.
- **Muted glyph** — `/state`'s `terminals[].muted` (`src/state/TerminalStateManager.js:41-45`
  documents what muting suppresses: the completion push and stuck-watch
  alerts to the manager — nothing about the terminal's own status tracking).
  Not asked for in the brief, but it's real, already-fetched data and one
  glyph costs nothing; listed as an open decision in §9 in case it's
  considered scope creep.

## 3. Statuses (exact strings, quoted from source)

Canonical values, per the header comment in `src/features/StatusManager.js:5-9`:

```
src/features/StatusManager.js:6   * - '...' (default/idle)
src/features/StatusManager.js:7   * - 'running' (process executing)
src/features/StatusManager.js:8   * - 'prompted' (Claude prompt active)
src/features/StatusManager.js:9   * - 'injecting' (message being injected)
```

and reconfirmed at `src/features/StatusManager.js:296-297`:

```
* 'running' | 'prompted' | 'injecting' | '...' | 'idle' | 'error' | ''.
```

In practice only four values are ever assigned to a terminal's `status`
field long enough for the TOC to observe them — `'running'`, `'prompted'`,
`'...'`, `'error'` — sourced from:

- `renderer.js:450-453` — PTY ready / no hook activity yet → sets `'...'`.
- `renderer.js:478` — hook event `notification` → `'prompted'`.
- `renderer.js:601-605` — an error condition → sets `'error'` explicitly.
- `src/state/TerminalStateManager.js:158` (docstring) — *"One of `'running'`
  \| `'prompted'` \| `'idle'` \| `'error'`"* (this docstring says `'idle'`;
  the code it documents actually stores the literal string `'...'` for that
  state everywhere else — the docstring is stale, the string is `'...'`).
- `'injecting'` (`src/features/StatusManager.js:47,109`) is a real but
  transient sub-state (message actively being typed into the PTY,
  `message:injection-started` → `message:injection-completed`). It resolves
  back to running/prompted/idle within a keystroke-delay window, so it isn't
  worth its own filter/sort bucket — treat it as `'running'`-adjacent for
  display (see open decision in §9) rather than adding a fifth pill.

Label/color mapping actually rendered today, `src/features/StatusManager.js:328-331`:

```js
const LABELS = { running: 'Running', prompted: 'Prompted', injecting: 'Injecting' };
// Anything that isn't an active state ('...', 'idle', 'error', '') is idle.
```

paired with the CSS at `style.css:305-315`:

```css
.terminal-status.running   { color: var(--accent-warning); }  /* style.css:305-307 */
.terminal-status.prompted  { color: var(--accent-purple);  }  /* style.css:309-311 */
.terminal-status.injecting { color: var(--accent-magenta); }  /* style.css:313-315 */
```

`'...'` gets no override, so it renders at the base `.terminal-status` color,
`var(--text-tertiary)` (`style.css:301`). **`'error'` has no CSS treatment
anywhere in `style.css` today** — despite being a real, reachable status
(`renderer.js:601-605`, `TerminalStateManager.js:186-190` adds the id to an
`errorTerminals` set). The TOC is the first UI to need an error color; it
uses `var(--accent-error)` per `COLOR_PALETTE.md:38`'s semantic table
("Error, destructive actions"), consistent with the palette even though nothing
else in the app currently uses it for this purpose.

TOC pill mapping: `Running` / `Prompted` / `Idle` / `Error`, colored exactly
as above.

## 4. Filter

Segmented chips: **All · Running · Prompted · Idle · Error**, each showing a
live count (`All 11`, `Running 4`, …). Defaults to **All**. This directly
answers "a filter so only filter by terminals are running" — Running is one
tap. A free-text box above the chips ("Filter terminals by name or
directory…") matches the brief's "if you can click one of the rows" framing
one step further: type-to-filter, matching against name, directory, and id
substring, is standard in every command-palette (VS Code's Ctrl+P, Linear's
Cmd+K) and was explicitly asked for in the redesign ask ("Make it
keyboard-first... typing filters by name").

## 5. Sort

Two modes, picked from a small `<select>` next to the filter row:

- **"Status, then last active" (default).** Groups `Running → Prompted →
  Error → Idle`, and within each group orders by most-recently-active first.
  This is the literal thing the owner described wanting — *"so I can see
  which ones are running from a quick list instead of scrolling"* — a pure
  alphabetical or pure-recency list would bury a `Running` terminal under
  nine idle ones with newer timestamps.
- **"Last active."** Pure recency across all statuses, ignoring group —
  useful for "what did I touch five minutes ago," independent of its current
  state. This is the literal "sort by last active" the owner also asked for.
- (Third option, "Name (A–Z)," included in the mockup as a low-cost freebie —
  not asked for, flagged in §9 in case it's unwanted.)

## 6. What "last active" is measured from

Not from raw PTY byte count or output-parsing (that whole approach is
deprecated per `CLAUDE.md`'s "no output-parsing state detection"). The one
timestamp the app already tracks per terminal is `TerminalStateManager`'s
`updatedAt` field, bumped on:

- **Creation** — `src/state/TerminalStateManager.js:47`.
- **Any status transition** (hook-driven: prompt-submit→running,
  notification→prompted, stop→`'...'`) — `src/state/TerminalStateManager.js:179`,
  called from `setTerminalStatus()` (`src/state/TerminalStateManager.js:161-182`).
- **Any PTY output chunk** — `renderer.js:438-441` (`terminal:data` handler).
- **Any real keystroke/paste the human types into that pane** —
  `renderer.js:2317-2324`, explicitly commented *"the human is here"* — this
  is the cleanest positive signal available and is separate from queue
  injection, which writes to the PTY over IPC and does **not** touch
  `updatedAt` (comment at `renderer.js:2314-2316`).

So "last active" = most recent of {created, status changed, PTY printed
something, you typed into it}. That's a reasonable definition of "active,"
but it means a terminal that's just streaming continuous Claude output looks
"more recently active" than one that's `prompted` and silently waiting on
you — which is exactly the ordering problem §5's default sort mode is
designed to route around (status group first, recency second).

**Gap to flag:** this field is tracked in the renderer's in-memory
`TerminalStateManager`, but it is **not currently included in the `/state`
HTTP payload.** `GET /state` (`main.js:591-605`, `getStateSnapshot()`) returns
a snapshot-level `updatedAt` (`renderer.js:756` — "when was this snapshot
generated," not per-terminal) but no per-terminal timestamp. Building the
real TOC means adding one field to the per-terminal object the renderer
already keeps in `AppStateStore`/`TerminalStateManager` and rendering it
client-side — no HTTP contract change needed, since the TOC lives entirely
in the renderer and can read `TerminalStateManager` directly. (Flagged here
because the mockup, built from a live `/state` capture, had to invent
per-terminal timestamps for the same reason — see the mockup's own comment
at the top of its `<script>` block.)

## 7. What clicking a row does

The brief asks for behavior "in each layout the app has (grid, tabs,
whatever exists)." **There is only one terminal layout, not several** — no
tab view exists. All visible terminals live in one `#terminals-container`
(`index.html:188`), and `relayoutTerminals()` (`renderer.js:2657-2700`)
always sets it to `layout-scroll` or `layout-scroll-vertical`
(`renderer.js:2680`), chunking terminals into pages of 1–8 (the
`settings.terminalsPerChunk` setting, `renderer.js:2640-2644`) styled by
`.chunk-N` rules (`style.css:384-577`). Terminals beyond the current chunk
require scrolling — horizontally by default, vertically if
`settings.chunkOrientation === 'vertical'` — to reach.

Two important things this codebase does **not** already do, confirmed by
grep — there is no existing "jump to terminal" feature to copy:

- `setActiveTerminal(id)` (`renderer.js:2702-2729`) sets the `.active` class,
  calls `.focus()` on the terminal, and updates the selector/status bar — but
  never scrolls anything into view.
- The terminal-selector dropdown's item click handler
  (`renderer.js:1272-1276`) only sets `queueTargetTerminalId` — it picks
  which terminal a *queued message* targets, and is not a navigation control
  at all.
- A grep for `scrollIntoView` across `renderer.js` returns zero matches.

So the TOC's row click needs genuinely new wiring, not reuse of an existing
"go to terminal N" path:

1. **Regular terminal (id ≠ 999).** Close the modal, then do the equivalent
   of `setActiveTerminal(id)` (active class + `.focus()` + selector/status
   bar update, `renderer.js:2702-2729`) **and** explicitly
   `wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' })` on that
   terminal's `.terminal-wrapper` (`data-terminal-id="<id>"`), since it may
   be in a chunk that's currently scrolled out of view. Briefly flash/outline
   the wrapper so the jump is visually obvious even if it was already
   on-screen.
2. **Manager (id 999).** The manager's xterm instance is mounted outside the
   grid entirely — `renderer.js:2694`'s comment: *"fits via its sidebar
   tab"* — and its wrapper carries a `manager-hidden` class
   (`renderer.js:2672,2695`) when the sidebar isn't showing it. Scrolling the
   grid does nothing for it. Clicking its row should instead trigger what
   `Cmd/Ctrl+M` already does (`renderer.js:1004`): `click('manager-nav-btn')`,
   switching the left sidebar to the Manager view.

The mockup demonstrates both paths (see `docs/terminal-toc-mockup.html`'s
`jumpTo()` — id 999 flashes a sidebar "Manager" card instead of a grid tile).

## 8. Empty states

Two distinct cases, not one:

- **Zero terminals exist.** Mirror the app's existing empty state
  (`index.html:234-241`, `.terminals-empty`, shown when every terminal is
  closed): icon, "No terminals open," "Spin up a Claude Code session to get
  started," and a New Terminal button. The TOC's version reuses this copy —
  no reason to invent different wording for the same condition.
- **A filter/search yields zero rows** (e.g., the Running chip when nothing
  is running — this is the real state of the live snapshot right now, see
  `docs/terminal-toc-preview/04-empty-filter-error.png`, captured against the
  **Error** chip since nothing is erroring). Distinct copy: "No terminals
  match this filter" / "Nothing is *(status)* right now," plus a "Clear
  filter" button that resets the chip and search box back to All. Conflating
  this with the zero-terminals case would make an active session look like
  it has no terminals at all, which is actively misleading.

## 9. Open decisions (max 4, with a recommended default)

1. **Does `'injecting'` get its own filter/status pill, or fold into
   Running?** *Recommended: fold into Running* (§3) — it's sub-second in
   practice and a fifth bucket for a rare transient state adds filter-chip
   clutter for no real benefit.
2. **Show the muted-bell glyph on rows?** (§2, not requested in the original
   ask.) *Recommended: yes* — it's already-fetched data, one glyph, and
   explains why a `Prompted` terminal isn't pinging you, which is exactly the
   kind of confusion this feature exists to resolve.
3. **Add a "Name (A–Z)" sort option beyond the two the owner asked for?**
   *Recommended: yes, as a third option, not the default* — cheap to add
   once the sort `<select>` exists, useful once terminal count is high enough
   that recency alone gets noisy, and it doesn't compete with either
   requested mode since it's not preselected.
4. **Where does "last active" live long-term — keep it renderer-only, or
   also expose it over `/state`?** (§6.) *Recommended: renderer-only for
   the TOC itself* (it's a renderer-side modal, no IPC round trip needed) but
   *do* add it to `/state`'s per-terminal payload anyway, since the Manager
   instance (`CLAUDE.md`'s "the manager instance" section) already polls
   `/state` and picking the most-idle terminal to nudge is a natural
   extension once the data exists.

## 10. Implementation plan (files that would change)

- `index.html` — add the button markup inside `<div class="header-left">`
  (`index.html:27`) and the modal markup (new `<div id="terminal-toc-modal">`,
  sibling to the existing `#message-history-modal` block around
  `index.html:830-849`, reusing `.modal`/`.modal-content` conventions).
- `style.css` — new rules for the modal's search row, filter chips, sort
  select, row layout, and status-pill colors (extending the pattern at
  `style.css:1967-2028` and `style.css:297-315`); the `no-drag` rule for the
  new header button (`style.css:222`/`4495-4496` precedent).
- `renderer.js` — the `Cmd/Ctrl+J` branch in the shortcut handler
  (`renderer.js:988-1013`); a new small controller (open/close, filter/sort
  state, keyboard nav, the `jumpTo()` logic from §7) reading
  `this.terminalStateManager`/`this.terminals` directly rather than a new
  IPC round trip, since the TOC only needs data the renderer already holds.
- `src/state/TerminalStateManager.js` — none required for a v1 built the way
  §7 describes (renderer already has everything: status, color, title,
  directory, muted, `updatedAt`). Only touched if open decision #4 is taken
  (adding `updatedAt` to the `/state` HTTP payload), which would also touch
  `main.js`'s `getStateSnapshot()`/`enrichSnapshot()` path (`main.js:591-605`).
- No backend (`backend/`) changes — this is a pure renderer/IPC-free feature.

---

## Proof the live app is untouched

No file outside `docs/` in this checkout was modified while producing this
spec and mockup. Verification method: a recursive SHA-256 over every tracked
and untracked file outside `docs/` and `.git/`, taken immediately before any
work started and again just before this document was finalized, plus a
`git status` diff.

```
find . -path ./docs -prune -o -path ./.git -prune -o -type f -print \
  | sort | xargs sha256sum > hashes.txt
```

- Files hashed (outside `docs/`, `.git/`): **284**, before and after — same count.
- **283 of 284 are byte-identical**, before vs. after. The one exception is
  `./aci-serve.log` — a gitignored (`.gitignore:130`), 22MB+ runtime log that
  the live Electron app itself appends to continuously while its 11 terminals
  run, independent of this task (its own contents show ordinary app
  chatter/atomic-store writes from the running sessions, not anything this
  task wrote). It isn't tracked by git, isn't source, and nothing in this
  task opened or wrote it — the app was going to keep growing that file
  every second regardless. `git status --porcelain` outside `docs/` is
  byte-identical before and after: same modified/untracked file list as when
  this task started, nothing changed shape.
- No restart, reload, or rebuild command was ever run against this app
  during this task — `docker compose ps` was checked once at the start per
  standing instructions and showed no containers running (this app doesn't
  depend on the backend for this task), and the live 11-terminal `/state`
  snapshot used for the mockup's sample data was fetched with a single
  read-only `GET /state` call.

Raw before/after hash manifests and the diff are not committed (per
instructions not to commit); they were computed and compared in-session.
