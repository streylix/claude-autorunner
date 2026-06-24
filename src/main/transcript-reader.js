/**
 * transcript-reader - Extracts Claude's last message from a session transcript
 *
 * The Stop hook's payload includes transcript_path: Claude Code's own JSONL
 * record of the session. Reading the last assistant message from that file is
 * authoritative - unlike capturing terminal output, it cannot race the hook
 * or miss content. Used to populate plain-English "completion" entries.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Read at most this much from the end of large transcripts; long sessions can
// reach tens of MB and the last assistant message is always near the end.
const TAIL_BYTES = 1024 * 1024;
const MAX_TEXT_LENGTH = 8000;

// Containment root for transcript reads. Claude Code stores every session
// transcript under ~/.claude/projects/<munged-dir>/<uuid>.jsonl. The Stop-hook
// payload's transcript_path arrives over the (token-authed but PTY-wide) HTTP
// control API, so it is attacker-influenced: a malicious local process holding
// CCBOT_TOKEN could POST a stop event with transcript_path pointing at, e.g.,
// ~/.ssh/id_rsa to exfiltrate it via the completion text. We refuse to read any
// path that does not resolve to a .jsonl file under the projects root.
const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

// Trusted containment roots. Production uses only the Claude projects dir.
// CCBOT_TRANSCRIPT_ROOTS (path-delimited) appends extra roots — used solely by
// the test harness to read fixtures from a temp dir; production never sets it.
function _trustedRoots() {
    const roots = [PROJECTS_ROOT];
    const extra = process.env.CCBOT_TRANSCRIPT_ROOTS;
    if (extra) roots.push(...extra.split(path.delimiter).filter(Boolean));
    return roots.map((r) => {
        try {
            return fs.realpathSync(r);
        } catch {
            return r; // may not exist yet; reads fail naturally and return null
        }
    });
}

// True only if `p` resolves (following symlinks) to a .jsonl file strictly
// inside a trusted root. realpathSync collapses `..` and symlinks, so a symlink
// planted under a root that points outside it is rejected.
function isTrustedTranscriptPath(p) {
    if (!p || typeof p !== 'string') return false;
    let real;
    try {
        real = fs.realpathSync(p);
    } catch {
        return false; // unreadable / nonexistent — nothing to contain
    }
    if (!real.endsWith('.jsonl')) return false;
    return _trustedRoots().some((root) => {
        const rel = path.relative(root, real);
        return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
}

// For the recent-messages endpoint: read a larger tail (tool_result entries can
// be large, so a few MB is needed to cover the last ~20 conversational turns).
const RECENT_TAIL_BYTES = 4 * 1024 * 1024;
const RECENT_DEFAULT_LIMIT = 20;
const RECENT_MAX_LIMIT = 100;
const RECENT_MAX_TEXT = 4000;

// Read the last `bytes` of a file as UTF-8, or null if unreadable. The first
// line of the result may be a partial JSON record (callers skip it on parse fail).
function readTail(filePath, bytes) {
    if (!isTrustedTranscriptPath(filePath)) return null;
    try {
        const stats = fs.statSync(filePath);
        const start = Math.max(0, stats.size - bytes);
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(stats.size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        fs.closeSync(fd);
        return buffer.toString('utf8');
    } catch (error) {
        return null;
    }
}

// Human-readable text for one transcript record's message.content (a string, or
// an array of text/thinking/tool_use/tool_result blocks). Returns the joined
// prose, or a compact `[tool_use: …]` marker for an assistant turn that only
// called tools, or '' for thinking-/tool-output-only records (which are dropped).
function extractMessageText(record) {
    const content = record.message && record.message.content;
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';

    const text = content
        .filter((b) => b && b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('\n')
        .trim();
    if (text) return text;

    const tools = content.filter((b) => b && b.type === 'tool_use').map((b) => b.name).filter(Boolean);
    return tools.length ? `[tool_use: ${tools.join(', ')}]` : '';
}

/**
 * Extract the text of the last assistant message in a transcript.
 * @param {string} transcriptPath - Path from the Stop hook payload
 * @returns {string|null} Message text, or null if unavailable
 */
function readLastAssistantText(transcriptPath) {
    if (!isTrustedTranscriptPath(transcriptPath)) return null;
    let tail;
    try {
        const stats = fs.statSync(transcriptPath);
        const start = Math.max(0, stats.size - TAIL_BYTES);
        const fd = fs.openSync(transcriptPath, 'r');
        const buffer = Buffer.alloc(stats.size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        fs.closeSync(fd);
        tail = buffer.toString('utf8');
    } catch (error) {
        return null;
    }

    const lines = tail.split('\n');
    // First line of a tail-read is likely a partial JSON line - it gets
    // skipped naturally by the parse failure below.
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;

        let record;
        try {
            record = JSON.parse(line);
        } catch {
            continue;
        }

        // Skip subagent sidechain entries - we want the main conversation
        if (record.isSidechain) continue;
        if (record.type !== 'assistant' || !record.message) continue;

        const content = record.message.content;
        let text = '';
        if (typeof content === 'string') {
            text = content;
        } else if (Array.isArray(content)) {
            text = content
                .filter((block) => block.type === 'text' && block.text)
                .map((block) => block.text)
                .join('\n');
        }

        text = text.trim();
        if (text) {
            return text.length > MAX_TEXT_LENGTH
                ? text.slice(0, MAX_TEXT_LENGTH) + '\n…[truncated]'
                : text;
        }
        // Assistant record with no text (pure tool-use turn) - keep walking back
    }

    return null;
}

/**
 * Parse the last N conversational turns from a transcript: human prompts and
 * assistant replies (with compact tool markers), skipping sidechains, thinking,
 * and raw tool output. Returns oldest-first, or null if the file is unreadable.
 * @param {string} transcriptPath
 * @param {{limit?:number, tailBytes?:number, maxTextLength?:number}} [opts]
 * @returns {Array<{role:string, text:string, ts:(string|null)}>|null}
 */
function readRecentMessages(transcriptPath, opts = {}) {
    if (!transcriptPath) return null;
    const tail = readTail(transcriptPath, opts.tailBytes || RECENT_TAIL_BYTES);
    if (tail === null) return null;

    const limit = Math.min(Math.max(1, opts.limit || RECENT_DEFAULT_LIMIT), RECENT_MAX_LIMIT);
    const maxText = opts.maxTextLength || RECENT_MAX_TEXT;

    const out = [];
    for (const raw of tail.split('\n')) {
        const line = raw.trim();
        if (!line) continue;

        let record;
        try {
            record = JSON.parse(line);
        } catch {
            continue; // partial first line / malformed - skip
        }

        if (record.isSidechain) continue;
        if (record.type !== 'user' && record.type !== 'assistant') continue;

        let text = extractMessageText(record);
        if (!text) continue; // tool-output-only / thinking-only - skip
        if (text.length > maxText) text = text.slice(0, maxText) + '\n…[truncated]';

        out.push({ role: record.type, text, ts: record.timestamp || null });
    }

    return out.slice(-limit);
}

/**
 * Build the /terminal/transcript response for a terminal id, resolving its
 * transcript path from the /state snapshot (never from caller-supplied paths).
 * @param {{terminalId:(number|string), limit?:number}} payload
 * @param {Object} snapshot - the renderer state snapshot ({ terminals:[...] })
 * @returns {{ok:boolean, ...}}
 */
function buildTranscriptResponse(payload = {}, snapshot) {
    const terminalId = parseInt(payload.terminalId, 10);
    if (!Number.isInteger(terminalId)) return { ok: false, error: 'invalid terminalId' };

    const terminals = snapshot && Array.isArray(snapshot.terminals) ? snapshot.terminals : null;
    const terminal = terminals ? terminals.find((t) => t.id === terminalId) : null;
    if (!terminal) return { ok: false, error: `terminal ${terminalId} not found` };
    if (!terminal.transcriptPath) {
        return { ok: false, error: `no transcript for terminal ${terminalId} (no Claude session yet)` };
    }

    const messages = readRecentMessages(terminal.transcriptPath, { limit: payload.limit });
    if (messages === null) return { ok: false, error: 'transcript unreadable' };

    return {
        ok: true,
        terminalId,
        sessionId: terminal.sessionId || null,
        transcriptPath: terminal.transcriptPath,
        count: messages.length,
        messages,
    };
}

module.exports = { readLastAssistantText, readRecentMessages, buildTranscriptResponse, isTrustedTranscriptPath };
