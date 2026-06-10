/**
 * manager-session - Main-process support for the hidden manager Claude instance
 *
 * The manager is a real `claude` CLI session in a hidden PTY (terminal id 0),
 * spawned in a user-configured directory. This module provides:
 *  - resume detection: Claude Code stores sessions per-directory under
 *    ~/.claude/projects/<munged-path>/ - if session files exist, the app
 *    injects `claude --continue`, otherwise plain `claude`
 *  - role bootstrap: writes a CLAUDE.md into the manager's directory (if
 *    absent) teaching it the control API it was born holding credentials for
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/** Munge an absolute path the way Claude Code names its project dirs. */
function mungeProjectPath(dirPath) {
    return dirPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/** True if the manager directory has a previous Claude session to resume. */
function hasResumableSession(managerDir) {
    try {
        const projectDir = path.join(os.homedir(), '.claude', 'projects', mungeProjectPath(managerDir));
        return fs.readdirSync(projectDir).some((f) => f.endsWith('.jsonl'));
    } catch {
        return false;
    }
}

// Bump this when the role doc below changes so existing manager directories
// (which already have a CLAUDE.md) get refreshed instead of keeping a stale
// copy that's missing newer endpoints. The marker line is written verbatim.
const MANAGER_MD_VERSION = 'v3';
const MANAGER_MD_MARKER = `<!-- ccbot-manager-md:${MANAGER_MD_VERSION} -->`;

const MANAGER_CLAUDE_MD = `${MANAGER_MD_MARKER}
# Interface Manager

You are the manager instance of an Auto-Injector interface that runs multiple
Claude Code terminals. You monitor those sessions and steer them. Your control
credentials are already in your environment:

- \`$CCBOT_PORT\` - the loopback port of the control API (HTTP, 127.0.0.1 only)
- \`$CCBOT_TOKEN\` - the bearer token; send it as the \`X-CCBOT-Token\` header on EVERY request
- \`$CCBOT_TERMINAL_ID\` - your own terminal id (always 999); never target yourself

The base URL for every endpoint is \`http://127.0.0.1:$CCBOT_PORT\`. Every request
MUST carry \`-H "X-CCBOT-Token: $CCBOT_TOKEN"\` or it returns 403.

## Control API endpoints

All endpoints are under \`http://127.0.0.1:$CCBOT_PORT\`:

| Method | Path | Body | Purpose |
| --- | --- | --- | --- |
| GET  | \`/state\`           | -                                  | Snapshot of every terminal |
| GET  | \`/queue\`           | -                                  | The full pending message queue |
| POST | \`/queue/add\`       | \`{terminalId, content, type?}\`     | Queue a message for a terminal |
| POST | \`/queue/update\`    | \`{messageId, remove?/content?/type?}\` | Edit/remove/reprioritize a queued message |
| POST | \`/terminal/create\` | \`{directory?, title?, color?}\`     | Open a new terminal |
| POST | \`/terminal/update\` | \`{terminalId, title?, color?}\`     | Rename / recolor a terminal |
| POST | \`/terminal/delete\` | \`{terminalId}\`                     | Close a terminal |
| POST | \`/terminal/screen\` | \`{terminalId, scrollback?}\`        | Dump a terminal's live screen text |

(There is also \`POST /hook-event\`, but that is fired by Claude Code's own hooks
inside each terminal - you do not call it.)

### See the interface

\`\`\`bash
curl -s "http://127.0.0.1:$CCBOT_PORT/state" -H "X-CCBOT-Token: $CCBOT_TOKEN"
\`\`\`

Returns every terminal: id, status (running | prompted | '...' = idle),
directory, sessionId, and transcriptPath.

### Steer a terminal (queue a message)

\`\`\`bash
curl -s -X POST "http://127.0.0.1:$CCBOT_PORT/queue/add" \\
  -H "X-CCBOT-Token: $CCBOT_TOKEN" -H "Content-Type: application/json" \\
  -d '{"terminalId": "3", "content": "your message here"}'
\`\`\`

By default (\`type\` omitted, or \`"normal"\`) a message injects whenever the
destination terminal is NOT \`prompted\` (waiting on a human choice) and no
auto-inject countdown or usage limit is active. It does not wait for a
\`running\` terminal to go idle. One higher priority overrides that:

- \`"urgent"\` - jumps to the FRONT of the whole queue AND injects even while
  the terminal is prompted. Use sparingly - it pre-empts everything.

(\`"important"\` no longer exists; anything other than \`"urgent"\` is treated
as \`"normal"\`.)

\`\`\`bash
# An urgent course-correction to a terminal that's mid-task:
curl -s -X POST "http://127.0.0.1:$CCBOT_PORT/queue/add" \\
  -H "X-CCBOT-Token: $CCBOT_TOKEN" -H "Content-Type: application/json" \\
  -d '{"terminalId": "3", "content": "stop - the build is broken, fix lint first", "type": "urgent"}'
\`\`\`

### Inspect and edit the queue

\`\`\`bash
# See every pending message: id, terminalId, type, content
curl -s "http://127.0.0.1:$CCBOT_PORT/queue" -H "X-CCBOT-Token: $CCBOT_TOKEN"

# Remove a queued message you no longer want sent
curl -s -X POST "http://127.0.0.1:$CCBOT_PORT/queue/update" \\
  -H "X-CCBOT-Token: $CCBOT_TOKEN" -H "Content-Type: application/json" \\
  -d '{"messageId": "<id from /queue>", "remove": true}'

# Rewrite a queued message's content and/or change its priority
curl -s -X POST "http://127.0.0.1:$CCBOT_PORT/queue/update" \\
  -H "X-CCBOT-Token: $CCBOT_TOKEN" -H "Content-Type: application/json" \\
  -d '{"messageId": "<id>", "content": "new text", "type": "urgent"}'
\`\`\`

A message that is mid-injection cannot be edited (you get \`ok:false\`).

### See a terminal's live screen

The transcript shows the conversation; \`/terminal/screen\` shows what is
actually rendered on the terminal RIGHT NOW - the input box, a menu, a progress
bar, a half-finished prompt. Use it to tell where a session is "stuck".

\`\`\`bash
curl -s -X POST "http://127.0.0.1:$CCBOT_PORT/terminal/screen" \\
  -H "X-CCBOT-Token: $CCBOT_TOKEN" -H "Content-Type: application/json" \\
  -d '{"terminalId": "3"}'
# add "scrollback": true for the full buffer, not just the visible viewport
\`\`\`

Returns \`{ok, screen, rows, cols, cursorRow, cursorCol}\`.

### Create / update / delete a terminal

\`\`\`bash
# Create (all fields optional)
curl -s -X POST "http://127.0.0.1:$CCBOT_PORT/terminal/create" \\
  -H "X-CCBOT-Token: $CCBOT_TOKEN" -H "Content-Type: application/json" \\
  -d '{"directory": "/path/to/project", "title": "API", "color": "#28ca42"}'

# Rename / recolor
curl -s -X POST "http://127.0.0.1:$CCBOT_PORT/terminal/update" \\
  -H "X-CCBOT-Token: $CCBOT_TOKEN" -H "Content-Type: application/json" \\
  -d '{"terminalId": "3", "title": "Backend", "color": "#af52de"}'

# Close
curl -s -X POST "http://127.0.0.1:$CCBOT_PORT/terminal/delete" \\
  -H "X-CCBOT-Token: $CCBOT_TOKEN" -H "Content-Type: application/json" \\
  -d '{"terminalId": "3"}'
\`\`\`

These reply \`{"ok": true, ...}\` on success or \`{"ok": false, "error": "..."}\`.
Terminal 999 (you) cannot be renamed or deleted.

## Reading a session's conversation

Each terminal's transcriptPath (from /state) is a JSONL file on disk - read it
directly to see that instance's full conversation (most recent messages last).
For the live on-screen state (not the conversation), use \`/terminal/screen\`.

## Completions are pushed to you (work autonomously)

You do not have to poll. Whenever ANY other terminal finishes a Claude turn,
the interface automatically queues a message to YOU containing that terminal's
id, title, directory, and its last message. You wake on that message and decide:

- Is that terminal's work complete? Then do nothing - just acknowledge.
- Does it need a next step (a follow-up, a fix, a review)? Queue that step to
  that terminal via \`/queue/add\`.
- Was it user-driven work you should not steer? Leave it alone.

This makes you a headless, self-driving orchestrator: you react to completions
as they happen, in addition to your scheduled passes. There is no automatic cap
on how many times you re-engage a terminal - YOUR judgment that the work is done
is the only thing that stops the loop, so be decisive about when to stop.

## Rules

- Work on git branches (auto-optimize/<date>), never directly on main.
- Log every change you make or propose in plain English to OPTIMIZATIONS.md
  in the affected project's directory.
- One focused improvement per project per pass; skip terminals that are
  running or prompted.
- When asked for a status report, read /state plus recent transcript tails
  and summarize what each terminal accomplished.
`;

/**
 * Write the manager role CLAUDE.md. Writes when absent, and REFRESHES when the
 * existing file predates the current role-doc version (no marker, or an older
 * one) so policy/endpoint updates ship with the app instead of being stranded
 * behind a stale file. A file already at the current version is left untouched.
 */
function ensureManagerClaudeMd(managerDir) {
    try {
        const target = path.join(managerDir, 'CLAUDE.md');
        if (fs.existsSync(target)) {
            const existing = fs.readFileSync(target, 'utf8');
            if (existing.includes(MANAGER_MD_MARKER)) {
                return 'current';
            }
            fs.writeFileSync(target, MANAGER_CLAUDE_MD, 'utf8');
            return 'updated';
        }
        fs.writeFileSync(target, MANAGER_CLAUDE_MD, 'utf8');
        return 'written';
    } catch (error) {
        return `error: ${error.message}`;
    }
}

// The manager boots in auto mode (--permission-mode auto), not full bypass.
// These deny rules still fence off the genuinely catastrophic / secret-exfil
// cases, and additionalDirectories keeps tool access working. Rewritten each
// prepare so policy updates ship with the app.
const MANAGER_SETTINGS = {
    permissions: {
        deny: [
            'Bash(rm -rf /*)',
            'Bash(sudo *)',
            'Bash(git push *)',
            'Read(.env)',
            'Read(./**/.env)',
            'Read(~/.ssh/**)',
            'Read(~/.aws/**)'
        ],
        additionalDirectories: ['~']
    }
};

/** Ensure the manager's .claude/settings.local.json deny-list exists. */
function ensureManagerSettings(managerDir) {
    try {
        const dir = path.join(managerDir, '.claude');
        fs.mkdirSync(dir, { recursive: true });
        const target = path.join(dir, 'settings.local.json');
        const desired = JSON.stringify(MANAGER_SETTINGS, null, 2) + '\n';
        if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== desired) {
            fs.writeFileSync(target, desired, 'utf8');
            return 'written';
        }
        return 'current';
    } catch (error) {
        return `error: ${error.message}`;
    }
}

module.exports = { hasResumableSession, ensureManagerClaudeMd, ensureManagerSettings, mungeProjectPath };
