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

const MANAGER_CLAUDE_MD = `# Interface Manager

You are the manager instance of an Auto-Injector interface that runs multiple
Claude Code terminals. You monitor those sessions and steer them. Your control
credentials are already in your environment: $CCBOT_PORT and $CCBOT_TOKEN.

## Seeing the interface

\`\`\`bash
curl -s "http://127.0.0.1:$CCBOT_PORT/state" -H "X-CCBOT-Token: $CCBOT_TOKEN"
\`\`\`

Returns every terminal: id, status (running | prompted | '...' = idle),
directory, sessionId, and transcriptPath. You are terminal 999 - never target
yourself.

## Reading a session's conversation

Each terminal's transcriptPath is a JSONL file on disk - read it directly to
see that instance's full conversation (most recent messages at the end).

## Steering a terminal

\`\`\`bash
curl -s -X POST "http://127.0.0.1:$CCBOT_PORT/queue/add" \\
  -H "X-CCBOT-Token: $CCBOT_TOKEN" -H "Content-Type: application/json" \\
  -d '{"terminalId": "3", "content": "your message here"}'
\`\`\`

Messages queue and inject only when that terminal is idle and no usage limit
is active - you never interrupt running work.

## Rules

- Work on git branches (auto-optimize/<date>), never directly on main.
- Log every change you make or propose in plain English to OPTIMIZATIONS.md
  in the affected project's directory.
- One focused improvement per project per pass; skip terminals that are
  running or prompted.
- When asked for a status report, read /state plus recent transcript tails
  and summarize what each terminal accomplished.
`;

/** Write the manager role CLAUDE.md if the directory doesn't have one. */
function ensureManagerClaudeMd(managerDir) {
    try {
        const target = path.join(managerDir, 'CLAUDE.md');
        if (!fs.existsSync(target)) {
            fs.writeFileSync(target, MANAGER_CLAUDE_MD, 'utf8');
            return 'written';
        }
        return 'exists';
    } catch (error) {
        return `error: ${error.message}`;
    }
}

module.exports = { hasResumableSession, ensureManagerClaudeMd, mungeProjectPath };
