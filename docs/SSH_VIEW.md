# SSH View — read-only live mirror over SSH

`ssh-view` is a **read-only** terminal UI that mirrors the whole Auto-Injector
interface — every terminal's live screen plus the manager (terminal 999) —
inside an SSH session. It is the way to watch a **headless** machine that is
running the app but has no monitor attached.

It is read-only **by construction**: it only ever calls the two non-mutating
Control API endpoints, `GET /state` and `POST /terminal/screen`. It never
queues, injects, creates, deletes, or steers anything.

## Run it

SSH into the machine running the app, then from the repo:

```bash
npm run ssh-view
```

Pass flags after `--`:

```bash
npm run ssh-view -- --scrollback          # show full scrollback, not just the viewport
npm run ssh-view -- --port 5000 --token abc123   # override discovery
npm run ssh-view -- --help
```

Or run the script directly: `node scripts/ssh-view.js`.

## Keys

| Key | Action |
| --- | --- |
| `↑` / `↓` / `j` / `k` | select previous / next terminal |
| `←` / `→` | cycle selection |
| `1`–`9` | jump to the Nth terminal in the list |
| `g` | toggle grid / single view (grid shows a condensed tile per terminal) |
| `s` | toggle scrollback (full buffer vs. visible viewport) |
| `r` | force an immediate refresh |
| `q` / `Ctrl-C` | quit |

The selected terminal's screen auto-refreshes about every 1.5s. The manager
terminal is listed as `999*`.

## How discovery works (auth)

The Control API binds `127.0.0.1` on an OS-assigned port and is authed by a
per-app-session token. Those live in the app's memory and in each spawned PTY's
env (`CCBOT_PORT` / `CCBOT_TOKEN`) — **a fresh SSH login shell does not inherit
them.**

So on startup the app writes a small session file:

```
$XDG_CONFIG_HOME/ccbot/session.json   (defaults to ~/.config/ccbot/session.json)
```

with `0600` perms in a `0700` dir, containing `{ port, token, apiBase, pid, … }`.
`ssh-view` reads that file to find the loopback API. The file is removed on a
clean app shutdown.

Discovery precedence:

1. `--port` / `--token` flags
2. `CCBOT_PORT` / `CCBOT_TOKEN` environment variables
3. `~/.config/ccbot/session.json`

The token is a **loopback-only** credential — `ssh-view` only ever sends it to
`127.0.0.1`, never off-host.

## Resilience

If the app / Control API is unreachable (app off, headless-display issue, or the
app restarting on a new port), `ssh-view` shows a "waiting for app…" screen and
keeps retrying every ~1.5s. It re-resolves the port/token on each retry, so a
restarted app on a new port is picked up automatically. It never crashes.

## Dependencies

None beyond Node built-ins (`http`, `readline`, `tty`). No new packages were
added.
