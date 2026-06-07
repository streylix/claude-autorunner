/**
 * transcript-reader - Extracts Claude's last message from a session transcript
 *
 * The Stop hook's payload includes transcript_path: Claude Code's own JSONL
 * record of the session. Reading the last assistant message from that file is
 * authoritative - unlike capturing terminal output, it cannot race the hook
 * or miss content. Used to populate plain-English "completion" entries.
 */
const fs = require('fs');

// Read at most this much from the end of large transcripts; long sessions can
// reach tens of MB and the last assistant message is always near the end.
const TAIL_BYTES = 1024 * 1024;
const MAX_TEXT_LENGTH = 8000;

/**
 * Extract the text of the last assistant message in a transcript.
 * @param {string} transcriptPath - Path from the Stop hook payload
 * @returns {string|null} Message text, or null if unavailable
 */
function readLastAssistantText(transcriptPath) {
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

module.exports = { readLastAssistantText };
