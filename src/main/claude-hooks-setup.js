/**
 * claude-hooks-setup - Installs Claude Code hooks for terminal state detection
 *
 * Merges three guarded hooks (Stop / Notification / UserPromptSubmit) into the
 * user's ~/.claude/settings.json. The hooks are no-ops outside app-spawned
 * terminals: they only fire when CCBOT_PORT / CCBOT_TERMINAL_ID env vars are
 * present, which the app injects into each PTY at spawn time.
 *
 * Why global settings instead of --settings flag or per-project settings:
 * the app spawns plain shells and users launch `claude` themselves, so the
 * hooks must already be registered wherever claude starts. Global + env-guard
 * covers every project with zero per-project setup.
 *
 * Idempotent: hooks are identified by the CCBOT_HOOK_MARKER string in their
 * command. Existing hooks are updated in place if the template changed,
 * other user hooks are never touched, and a parse failure aborts without
 * writing (never clobbers the user's settings).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// Marker embedded in every command we own; used for idempotent detection.
const CCBOT_HOOK_MARKER = 'CCBOT_PORT';

// Claude Code hook event -> event name sent to the app's HookServer
const HOOK_EVENTS = {
    Stop: 'stop',
    Notification: 'notification',
    UserPromptSubmit: 'prompt-submit',
    CwdChanged: 'cwd-changed'
};

/**
 * Build the shell command for one hook event.
 * - Guarded: exits 0 silently when not inside an app terminal.
 * - Captures the hook's stdin JSON and splices it into the POST body so the
 *   app receives session_id / cwd / notification message context.
 * - Short timeout, all output suppressed, always exits 0 so a dead app
 *   never surfaces hook errors inside Claude Code sessions.
 */
function buildHookCommand(eventName) {
    return (
        `if [ -n "$${CCBOT_HOOK_MARKER}" ] && [ -n "$CCBOT_TERMINAL_ID" ]; then ` +
        `payload=$(cat); ` +
        `curl -sf -m 2 -X POST "http://127.0.0.1:\${CCBOT_PORT}/hook-event" ` +
        `-H "Content-Type: application/json" ` +
        `-H "X-CCBOT-Token: \${CCBOT_TOKEN}" ` +
        `-d "{\\"terminalId\\":\\"\${CCBOT_TERMINAL_ID}\\",\\"event\\":\\"${eventName}\\",\\"hook\\":\${payload:-null}}" ` +
        `>/dev/null 2>&1; ` +
        `fi; exit 0`
    );
}

function buildHookEntry(eventName) {
    return {
        hooks: [
            {
                type: 'command',
                command: buildHookCommand(eventName),
                async: true,
                timeout: 5
            }
        ]
    };
}

function isCcbotHookGroup(group) {
    return Array.isArray(group.hooks) &&
        group.hooks.some(h => typeof h.command === 'string' && h.command.includes(CCBOT_HOOK_MARKER));
}

/**
 * Ensure our hooks exist (and are current) in the user's Claude settings.
 * @param {string} [settingsPath] - Override for testing
 * @returns {{status: string, changed: string[], error?: string}}
 */
function ensureClaudeHooks(settingsPath) {
    const targetPath = settingsPath || path.join(os.homedir(), '.claude', 'settings.json');
    let settings = {};
    let changed = [];

    try {
        if (fs.existsSync(targetPath)) {
            const raw = fs.readFileSync(targetPath, 'utf8');
            settings = JSON.parse(raw);
        }
    } catch (error) {
        // Never risk clobbering an unparseable settings file
        return { status: 'aborted', changed: [], error: `Could not parse ${targetPath}: ${error.message}` };
    }

    if (!settings.hooks || typeof settings.hooks !== 'object') {
        settings.hooks = {};
    }

    for (const [claudeEvent, appEvent] of Object.entries(HOOK_EVENTS)) {
        const desiredEntry = buildHookEntry(appEvent);

        if (!Array.isArray(settings.hooks[claudeEvent])) {
            settings.hooks[claudeEvent] = [];
        }

        const groups = settings.hooks[claudeEvent];
        const existingIndex = groups.findIndex(isCcbotHookGroup);

        if (existingIndex === -1) {
            groups.push(desiredEntry);
            changed.push(`${claudeEvent}: installed`);
        } else if (JSON.stringify(groups[existingIndex]) !== JSON.stringify(desiredEntry)) {
            groups[existingIndex] = desiredEntry;
            changed.push(`${claudeEvent}: updated`);
        }
    }

    if (changed.length === 0) {
        return { status: 'current', changed: [] };
    }

    try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        // Atomic write: temp file + rename so a crash can't truncate settings
        const tmpPath = `${targetPath}.ccbot-tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
        fs.renameSync(tmpPath, targetPath);
        return { status: 'written', changed };
    } catch (error) {
        return { status: 'aborted', changed: [], error: `Could not write ${targetPath}: ${error.message}` };
    }
}

/**
 * Remove our hooks from the user's Claude settings (uninstall / cleanup).
 * @param {string} [settingsPath] - Override for testing
 */
function removeClaudeHooks(settingsPath) {
    const targetPath = settingsPath || path.join(os.homedir(), '.claude', 'settings.json');

    try {
        if (!fs.existsSync(targetPath)) {
            return { status: 'current', changed: [] };
        }

        const settings = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
        if (!settings.hooks) {
            return { status: 'current', changed: [] };
        }

        const changed = [];
        for (const claudeEvent of Object.keys(HOOK_EVENTS)) {
            const groups = settings.hooks[claudeEvent];
            if (!Array.isArray(groups)) continue;

            const filtered = groups.filter(group => !isCcbotHookGroup(group));
            if (filtered.length !== groups.length) {
                changed.push(`${claudeEvent}: removed`);
                if (filtered.length === 0) {
                    delete settings.hooks[claudeEvent];
                } else {
                    settings.hooks[claudeEvent] = filtered;
                }
            }
        }

        if (changed.length === 0) {
            return { status: 'current', changed: [] };
        }

        const tmpPath = `${targetPath}.ccbot-tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
        fs.renameSync(tmpPath, targetPath);
        return { status: 'written', changed };
    } catch (error) {
        return { status: 'aborted', changed: [], error: error.message };
    }
}

module.exports = { ensureClaudeHooks, removeClaudeHooks, buildHookCommand, CCBOT_HOOK_MARKER };
