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
    inspectRemoteSession,
    buildEnsureCommand,
    explainEnsureFailure,
    parseEnsureResult,
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

// ---- appDir (Advanced "remote app directory" for auto-start) ----

test('appDir: allows plain and tilde paths, rejects shell characters', () => {
    assert.strictEqual(normalizeConnectOptions({ host: 'ok', appDir: '~/apps/auto-injector' }).appDir, '~/apps/auto-injector');
    assert.strictEqual(normalizeConnectOptions({ host: 'ok', appDir: '/opt/claude-autorunner' }).appDir, '/opt/claude-autorunner');
    assert.throws(() => normalizeConnectOptions({ host: 'ok', appDir: '/a b/c' }), /Invalid remote app directory/);
    assert.throws(() => normalizeConnectOptions({ host: 'ok', appDir: '$(rm)/x' }), /Invalid remote app directory/);
});

// ---- inspectRemoteSession (the auto-start decision tree) ----

test('inspectRemoteSession classifies remote-on / remote-off / unreadable', () => {
    const on = inspectRemoteSession(JSON.stringify({ port: 41234, token: 't', remote: { port: 8130 } }));
    assert.deepStrictEqual(on, { state: 'remote-on', token: 't', hookPort: 41234, remotePort: 8130 });
    const off = inspectRemoteSession(JSON.stringify({ port: 41234, token: 't', remote: null }));
    assert.deepStrictEqual(off, { state: 'remote-off', token: 't', hookPort: 41234 });
    assert.strictEqual(inspectRemoteSession('garbage').state, 'unreadable');
    assert.strictEqual(inspectRemoteSession(JSON.stringify({ port: 1 })).state, 'unreadable');
});

// ---- buildEnsureCommand (the remote auto-start sh command) ----

test('ensure command: default paths use the remote XDG expression', () => {
    const conn = normalizeConnectOptions({ host: 'box', username: 'ethan' });
    const cmd = buildEnsureCommand(conn);
    assert.match(cmd, /XDG_CONFIG_HOME:-\$HOME\/.config}\/ccbot/);
    assert.match(cmd, /\. "\$cfg\/app-root"/);                    // sources the recorded app location
    assert.match(cmd, /remote-autostart\.js/);
    assert.match(cmd, /ELECTRON_RUN_AS_NODE=1 exec/);
    assert.ok(!cmd.includes("'"), 'must contain NO single quotes (remote shell safety)');
});

test('ensure command: session path override drives cfg dir + session file', () => {
    const conn = normalizeConnectOptions({ host: 'box', sessionPath: '/tmp/cfg/ccbot/session.json' });
    const cmd = buildEnsureCommand(conn);
    assert.match(cmd, /cfg=\$\(dirname \/tmp\/cfg\/ccbot\/session\.json\)/);
    assert.match(cmd, /--session-file \/tmp\/cfg\/ccbot\/session\.json/);
});

test('ensure command: Advanced app dir bypasses the app-root file', () => {
    const conn = normalizeConnectOptions({ host: 'box', appDir: '/opt/app' });
    const cmd = buildEnsureCommand(conn);
    assert.match(cmd, /d=\/opt\/app/);
    assert.ok(!cmd.includes('app-root'), 'must not read app-root when overridden');
});

// ---- explainEnsureFailure / parseEnsureResult ----

test('ensure failure markers map to specific user-facing messages', () => {
    assert.match(explainEnsureFailure('CCBOT_ERR_NO_APP_ROOT', '', 'e@h'), /never run on e@h[\s\S]*Remote app directory/);
    assert.match(explainEnsureFailure('CCBOT_ERR_APP_DIR:/gone/dir', '', 'e@h'), /\/gone\/dir.*no longer exists/);
    assert.match(explainEnsureFailure('CCBOT_ERR_OLD_APP:/old/dir', '', 'e@h'), /too old for auto-start/);
    assert.match(explainEnsureFailure('CCBOT_ERR_NO_NODE', '', 'e@h'), /Node runtime/);
});

test('ensure failure falls back to the script JSON error, then ssh stderr', () => {
    const out = 'CCBOT_AUTOSTART_STATUS:x\nCCBOT_AUTOSTART_RESULT:{"ok":false,"error":"xvfb-run is not installed"}';
    assert.match(explainEnsureFailure(out, '', 'e@h'), /xvfb-run is not installed/);
    assert.match(explainEnsureFailure('', 'Permission denied (publickey)', 'e@h'), /authentication failed/);
});

test('parseEnsureResult reads the last result line, tolerates noise', () => {
    const out = 'noise\nCCBOT_AUTOSTART_STATUS:starting\nCCBOT_AUTOSTART_RESULT:{"ok":true,"action":"started","port":8130}\n';
    assert.deepStrictEqual(parseEnsureResult(out), { ok: true, action: 'started', port: 8130 });
    assert.strictEqual(parseEnsureResult('no result here'), null);
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
