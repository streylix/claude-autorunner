'use strict';

// Tests for TtsRemoteForwarder — the main-process side of "voice notifications
// play on the device showing the interface" (docs/REMOTE_MODE.md §9):
//   - activating on the FIRST attached client baselines the watermark, so
//     pre-existing notifications are never replayed into a fresh client;
//   - a notification created while a client is attached is forwarded with its
//     real audio bytes (base64) over the broadcast hook;
//   - the watermark advances, nothing is forwarded twice;
//   - detach (count 0) stops polling; re-attach re-baselines.
// Run: node --test src/main/tts-remote-forwarder.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const TtsRemoteForwarder = require('./tts-remote-forwarder');

/** Minimal stand-in for the Django TTS backend (same routes + shapes). */
function makeBackend() {
    const state = { notifications: [], audio: new Map() };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (req.method === 'GET' && url.pathname === '/api/tts/notifications/') {
            const after = Number(url.searchParams.get('after') || 0);
            const limit = Number(url.searchParams.get('limit') || 100);
            const items = state.notifications
                .filter((n) => n.id > after)
                .sort((a, b) => b.id - a.id) // newest-first, like the real backend
                .slice(0, limit);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ notifications: items }));
            return;
        }
        const audioMatch = /^\/api\/tts\/audio\/(\d+)\/$/.exec(url.pathname);
        if (req.method === 'GET' && audioMatch) {
            const bytes = state.audio.get(Number(audioMatch[1]));
            if (!bytes) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'Content-Type': 'audio/wav' });
            res.end(bytes);
            return;
        }
        res.writeHead(404);
        res.end();
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                state,
                server,
                url: 'http://127.0.0.1:' + server.address().port,
                addNotification(id, audioBytes) {
                    state.notifications.push({
                        id,
                        terminal_id: '999',
                        terminal_name: 'manager',
                        text: 'notification ' + id,
                        voice: 'af_heart',
                        speed: 1,
                        source: 'manager',
                        duration_ms: 400,
                        played: false,
                        created_at: new Date().toISOString(),
                        audio_url: audioBytes ? `/api/tts/audio/${id}/` : null
                    });
                    if (audioBytes) state.audio.set(id, audioBytes);
                }
            });
        });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (fn()) return;
        if (Date.now() > deadline) throw new Error('timed out waiting for ' + what);
        await sleep(25);
    }
}

test('baseline on attach: pre-existing notifications are NOT forwarded; fresh ones are, with real audio bytes', async () => {
    const backend = await makeBackend();
    const pushed = [];
    const fwd = new TtsRemoteForwarder({
        backendUrl: backend.url,
        broadcast: (channel, args) => pushed.push({ channel, args }),
        log: () => {}
    });
    try {
        // History that must never replay into a fresh client.
        backend.addNotification(1, Buffer.from('OLD-AUDIO'));
        backend.addNotification(2, Buffer.from('OLD-AUDIO-2'));

        fwd.setClientCount(1); // first client attaches → baseline tick runs
        await waitFor(() => fwd.lastSeenId === 2, 2000, 'baseline at id 2');
        assert.strictEqual(pushed.length, 0, 'history was not forwarded');

        // A notification created while the client is attached IS forwarded.
        const wav = Buffer.from('RIFF-fake-wav-bytes-for-test');
        backend.addNotification(3, wav);
        await fwd._tick();
        assert.strictEqual(pushed.length, 1, 'exactly one push');
        assert.strictEqual(pushed[0].channel, 'remote-tts-notification');
        const payload = pushed[0].args[0];
        assert.strictEqual(payload.notification.id, 3);
        assert.strictEqual(payload.mime, 'audio/wav');
        assert.strictEqual(
            Buffer.from(payload.audioBase64, 'base64').toString(),
            wav.toString(),
            'the exact audio bytes ride the push, base64-encoded'
        );
        assert.strictEqual(fwd.lastSeenId, 3, 'watermark advanced');

        // Same tick again: nothing new → nothing re-forwarded.
        await fwd._tick();
        assert.strictEqual(pushed.length, 1, 'no duplicate forwards');
    } finally {
        fwd.stop();
        backend.server.close();
    }
});

test('detach stops forwarding; re-attach re-baselines (missed items are not replayed)', async () => {
    const backend = await makeBackend();
    const pushed = [];
    const fwd = new TtsRemoteForwarder({
        backendUrl: backend.url,
        broadcast: (channel, args) => pushed.push({ channel, args }),
        log: () => {}
    });
    try {
        fwd.setClientCount(1);
        await waitFor(() => fwd.lastSeenId === 0, 2000, 'empty baseline');

        fwd.setClientCount(0); // last client detached
        assert.strictEqual(fwd.active, false);
        assert.strictEqual(fwd.timer, null, 'poll timer cleared');

        // Created while nobody is attached → played locally, never forwarded.
        backend.addNotification(1, Buffer.from('LOCAL-ONLY'));

        fwd.setClientCount(2); // clients again → fresh baseline swallows id 1
        await waitFor(() => fwd.lastSeenId === 1, 2000, 're-baseline at id 1');
        await fwd._tick();
        assert.strictEqual(pushed.length, 0, 'notification from the detached window not replayed');

        backend.addNotification(2, Buffer.from('FRESH'));
        await fwd._tick();
        assert.strictEqual(pushed.length, 1);
        assert.strictEqual(pushed[0].args[0].notification.id, 2);
    } finally {
        fwd.stop();
        backend.server.close();
    }
});

test('a notification without audio still forwards its row (audioBase64 null)', async () => {
    const backend = await makeBackend();
    const pushed = [];
    const fwd = new TtsRemoteForwarder({
        backendUrl: backend.url,
        broadcast: (channel, args) => pushed.push({ channel, args }),
        log: () => {}
    });
    try {
        fwd.setClientCount(1);
        await waitFor(() => fwd.lastSeenId === 0, 2000, 'empty baseline');
        backend.addNotification(1, null);
        await fwd._tick();
        assert.strictEqual(pushed.length, 1);
        assert.strictEqual(pushed[0].args[0].notification.id, 1);
        assert.strictEqual(pushed[0].args[0].audioBase64, null);
    } finally {
        fwd.stop();
        backend.server.close();
    }
});
