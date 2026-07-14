'use strict';

// Unit tests for remote-client's pure helpers — the input validation that
// keeps renderer form values from being parsed as ssh options, the session
// file parsing (incl. the "Remote Mode is OFF" case), and the stderr
// classifier that turns ssh failures into actionable UI messages.
// Run: node --test src/main/remote-client.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const {
    normalizeConnectOptions,
    parseRemoteSession,
    classifySshFailure
} = require('./remote-client');

// ---- normalizeConnectOptions ----

test('accepts host + user + port and builds user@host dest', () => {
    const c = normalizeConnectOptions({ host: 'my-box.local', username: 'ethan', sshPort: 2222 });
    assert.strictEqual(c.dest, 'ethan@my-box.local');
    assert.strictEqual(c.sshPort, 2222);
});

test('defaults ssh port to 22 and allows empty username (ssh config decides)', () => {
    const c = normalizeConnectOptions({ host: '192.168.1.10' });
    assert.strictEqual(c.sshPort, 22);
    assert.strictEqual(c.dest, '192.168.1.10');
});

test('rejects a missing host', () => {
    assert.throws(() => normalizeConnectOptions({ host: '  ' }), /Enter a host/);
});

test('rejects a host that could be parsed as an ssh option', () => {
    assert.throws(() => normalizeConnectOptions({ host: '-oProxyCommand=evil' }), /Invalid host/);
});

test('rejects shell metacharacters in host and username', () => {
    assert.throws(() => normalizeConnectOptions({ host: 'a;rm -rf /' }), /Invalid host/);
    assert.throws(() => normalizeConnectOptions({ host: 'ok', username: 'a b' }), /Invalid username/);
    assert.throws(() => normalizeConnectOptions({ host: 'ok', username: '$(x)' }), /Invalid username/);
});

test('rejects out-of-range or non-integer ssh ports', () => {
    assert.throws(() => normalizeConnectOptions({ host: 'ok', sshPort: 0 }), /Invalid SSH port/);
    assert.throws(() => normalizeConnectOptions({ host: 'ok', sshPort: 70000 }), /Invalid SSH port/);
    assert.throws(() => normalizeConnectOptions({ host: 'ok', sshPort: 22.5 }), /Invalid SSH port/);
});

test('session path: allows plain and tilde paths, rejects quotes/spaces/$', () => {
    assert.strictEqual(
        normalizeConnectOptions({ host: 'ok', sessionPath: '/tmp/cfg/ccbot/session.json' }).sessionPath,
        '/tmp/cfg/ccbot/session.json'
    );
    assert.strictEqual(
        normalizeConnectOptions({ host: 'ok', sessionPath: '~/.config/ccbot/session.json' }).sessionPath,
        '~/.config/ccbot/session.json'
    );
    assert.throws(() => normalizeConnectOptions({ host: 'ok', sessionPath: '/a b/c' }), /Invalid session file path/);
    assert.throws(() => normalizeConnectOptions({ host: 'ok', sessionPath: '$(rm)/x' }), /Invalid session file path/);
    assert.throws(() => normalizeConnectOptions({ host: 'ok', sessionPath: "a';x" }), /Invalid session file path/);
});

test('ssh options: tokenized on whitespace, unsafe tokens rejected', () => {
    const c = normalizeConnectOptions({
        host: 'ok',
        sshOptions: '-i /tmp/key -o UserKnownHostsFile=/tmp/kh -o IdentitiesOnly=yes'
    });
    assert.deepStrictEqual(c.extraArgs, ['-i', '/tmp/key', '-o', 'UserKnownHostsFile=/tmp/kh', '-o', 'IdentitiesOnly=yes']);
    assert.throws(() => normalizeConnectOptions({ host: 'ok', sshOptions: '-o Proxy;rm' }), /Invalid SSH option/);
    assert.throws(() => normalizeConnectOptions({ host: 'ok', sshOptions: '`x`' }), /Invalid SSH option/);
});

// ---- parseRemoteSession ----

test('parses token + remote port from a full session file', () => {
    const raw = JSON.stringify({ port: 41234, token: 'abc123', remote: { port: 8130 } });
    assert.deepStrictEqual(parseRemoteSession(raw, 'box'), { token: 'abc123', remotePort: 8130 });
});

test('app running but Remote Mode OFF -> tells the user to enable CCBOT_REMOTE=1', () => {
    const raw = JSON.stringify({ port: 41234, token: 'abc123', remote: null });
    assert.throws(() => parseRemoteSession(raw, 'box'), /Remote Mode is OFF[\s\S]*CCBOT_REMOTE=1/);
});

test('garbage / empty session file -> "is the app running" message', () => {
    assert.throws(() => parseRemoteSession('No such file', 'box'), /is the Auto-Injector app running/);
    assert.throws(() => parseRemoteSession('', 'box'), /is the Auto-Injector app running/);
});

test('incomplete session file -> restart message', () => {
    assert.throws(() => parseRemoteSession(JSON.stringify({ port: 1 }), 'box'), /incomplete/);
});

// ---- classifySshFailure ----

test('classifies auth, host-key, missing-file, dns and refused failures', () => {
    assert.match(classifySshFailure('ethan@h: Permission denied (publickey).', 'ethan@h'), /authentication failed/);
    assert.match(classifySshFailure('Host key verification failed.', 'h'), /Host key verification failed/);
    assert.match(classifySshFailure('@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @', 'h'), /HOST KEY CHANGED/);
    assert.match(classifySshFailure('cat: /x: No such file or directory', 'h'), /not running there|No ccbot session file/);
    assert.match(classifySshFailure('ssh: Could not resolve hostname h', 'h'), /resolve/);
    assert.match(classifySshFailure('connect to host h port 22: Connection refused', 'h'), /refused/);
    assert.match(classifySshFailure('connect to host h port 22: Connection timed out', 'h'), /timed out/);
});

test('unknown stderr falls back to the first meaningful line', () => {
    const msg = classifySshFailure('Warning: Permanently added x\nsome odd failure', 'h');
    assert.match(msg, /some odd failure/);
});
