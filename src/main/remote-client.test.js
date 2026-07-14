'use strict';

// Unit tests for remote-client's pure helpers — the input validation that
// keeps renderer form values from being parsed as ssh options, the session
// file parsing (incl. the "Remote Mode is OFF" case), and the stderr
// classifier that turns ssh failures into actionable UI messages.
// Run: node --test src/main/remote-client.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const RemoteClient = require('./remote-client');
const {
    normalizeConnectOptions,
    parseRemoteSession,
    inspectRemoteSession,
    buildEnsureCommand,
    explainEnsureFailure,
    parseEnsureResult,
    classifySshFailure,
    isAuthFailure,
    sshFailureToError,
    buildSshInvocation
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

// ---- key→password fallback (isAuthFailure / sshFailureToError) ----

test('isAuthFailure: auth failures yes; unreachable/host-key problems no', () => {
    assert.strictEqual(isAuthFailure('ethan@h: Permission denied (publickey,password).'), true);
    assert.strictEqual(isAuthFailure('Too many authentication failures'), true);
    assert.strictEqual(isAuthFailure('@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\nPermission denied'), false);
    assert.strictEqual(isAuthFailure('Host key verification failed.'), false);
    assert.strictEqual(isAuthFailure('connect to host h port 22: Connection refused'), false);
    assert.strictEqual(isAuthFailure('ssh: Could not resolve hostname h'), false);
    assert.strictEqual(isAuthFailure(''), false);
});

test('sshFailureToError: key-only auth failure asks for the password (needPassword)', () => {
    const conn = normalizeConnectOptions({ host: 'h', username: 'e' });
    const err = sshFailureToError('e@h: Permission denied (publickey).', conn);
    assert.strictEqual(err.needPassword, true);
    assert.match(err.message, /Key authentication failed for e@h/);
    assert.match(err.message, /password/i);
});

test('sshFailureToError: wrong password says so and allows retry (needPassword)', () => {
    const conn = normalizeConnectOptions({ host: 'h', username: 'e', password: 'nope' });
    const err = sshFailureToError('e@h: Permission denied (password).', conn);
    assert.strictEqual(err.needPassword, true);
    assert.match(err.message, /Wrong password for e@h/);
});

test('sshFailureToError: non-auth failures never ask for a password', () => {
    const conn = normalizeConnectOptions({ host: 'h' });
    const err = sshFailureToError('connect to host h port 22: Connection refused', conn);
    assert.ok(!err.needPassword);
    assert.match(err.message, /refused/);
});

// ---- password plumbing (argv/env separation) ----

test('normalizeConnectOptions passes the password through untouched (any chars)', () => {
    const pw = 'sp aces "quotes" $(sub) \'單\' -leading';
    const c = normalizeConnectOptions({ host: 'h', username: 'e', password: pw });
    assert.strictEqual(c.password, pw);
    // and its absence normalizes to ''
    assert.strictEqual(normalizeConnectOptions({ host: 'h' }).password, '');
});

test('_baseSshArgs: BatchMode without a password; password mode swaps in one-prompt password auth', () => {
    const client = new RemoteClient();
    const keyArgs = client._baseSshArgs(normalizeConnectOptions({ host: 'h' }));
    assert.ok(keyArgs.includes('BatchMode=yes'));
    assert.ok(!keyArgs.join(' ').includes('PreferredAuthentications'));

    const pwArgs = client._baseSshArgs(normalizeConnectOptions({ host: 'h', password: 's3cret' }));
    assert.ok(!pwArgs.includes('BatchMode=yes'), 'password mode must not set BatchMode');
    assert.ok(pwArgs.includes('NumberOfPasswordPrompts=1'), 'wrong password must fail fast');
    assert.ok(pwArgs.includes('PreferredAuthentications=password,keyboard-interactive'));
    assert.ok(!pwArgs.join(' ').includes('s3cret'), 'the password must NEVER be in the argv');
});

test('buildSshInvocation: askpass env carries the password; argv stays clean', () => {
    const conn = normalizeConnectOptions({ host: 'h', password: 'p@ss w0rd' });
    const inv = buildSshInvocation(conn, { PATH: '/usr/bin' });
    // On this machine the bundled helper exists → askpass is the mechanism.
    assert.strictEqual(inv.command, 'ssh');
    assert.deepStrictEqual(inv.argsPrefix, []);
    assert.strictEqual(inv.env.CCBOT_SSH_PASSWORD, 'p@ss w0rd');
    assert.strictEqual(inv.env.SSH_ASKPASS_REQUIRE, 'force');
    assert.ok(inv.env.DISPLAY, 'DISPLAY must be set for older ssh');
    assert.strictEqual(path.basename(inv.env.SSH_ASKPASS), 'ssh-askpass.sh');
});

test('buildSshInvocation: no password → plain ssh with inherited env', () => {
    const inv = buildSshInvocation(normalizeConnectOptions({ host: 'h' }));
    assert.strictEqual(inv.command, 'ssh');
    assert.strictEqual(inv.env, undefined);
});

// ---- reconnect supersedes / renderer-reload orphan cleanup ----

/** A fake long-lived tunnel child: records kills, looks alive until killed. */
function fakeChild() {
    const child = {
        killed: [],
        exitCode: null,
        signalCode: null,
        kill(sig) { this.killed.push(sig); this.exitCode = 0; }
    };
    return child;
}

test('connect() while (stale-)connected SUPERSEDES: kills the old tunnel and proceeds instead of "already connected"', async () => {
    const client = new RemoteClient();
    // Simulate the renderer-reload orphan: main still holds a live tunnel +
    // connected state, while the UI has forgotten everything.
    const orphan = fakeChild();
    client.tunnelChild = orphan;
    client.state = { phase: 'connected', host: 'old-host' };
    // Stub the first network step so the NEW attempt visibly proceeds (and
    // fails with OUR error — proving the old guard no longer throws first).
    client._readRemoteSession = async () => { throw new Error('reached-session-read'); };
    await assert.rejects(() => client.connect({ host: 'new-host' }), /reached-session-read/);
    assert.deepStrictEqual(orphan.killed, ['SIGTERM'], 'the stale tunnel child must be killed first');
    assert.strictEqual(client.tunnelChild, null);
    assert.strictEqual(client.state.phase, 'error', 'the new attempt owns the state');
});

test('disconnect() aborts an in-flight connect at its next checkpoint (no error state over idle)', async () => {
    const client = new RemoteClient();
    let release;
    client._readRemoteSession = () => new Promise((r) => { release = r; });
    const attempt = client.connect({ host: 'h' });
    attempt.catch(() => {}); // observed below
    assert.strictEqual(client.state.phase, 'connecting');
    client.disconnect();
    assert.strictEqual(client.state.phase, 'idle');
    release({ state: 'remote-on', token: 't', remotePort: 1234 });
    await assert.rejects(() => attempt, (err) => err.superseded === true);
    // The superseded attempt must NOT clobber the idle state or spawn anything.
    assert.strictEqual(client.state.phase, 'idle');
    assert.strictEqual(client.tunnelChild, null);
});

test('a second connect() supersedes an in-flight first one (first rejects superseded, no state clobber)', async () => {
    const client = new RemoteClient();
    let releaseFirst;
    const gates = [new Promise((r) => { releaseFirst = r; }), Promise.resolve(null)];
    client._readRemoteSession = () => gates.shift() || Promise.resolve(null);
    const first = client.connect({ host: 'h' });
    first.catch(() => {});
    // Second attempt: its (immediate) session read returns null → it errors,
    // but only AFTER it has bumped the generation and taken over the state.
    const second = client.connect({ host: 'h' });
    second.catch(() => {});
    releaseFirst({ state: 'remote-on', token: 't', remotePort: 1234 });
    await assert.rejects(() => first, (err) => err.superseded === true);
    await assert.rejects(() => second); // its own (stubbed) failure
    assert.strictEqual(client.state.phase, 'error', 'the SECOND attempt owns the final state');
});

test('disconnect() is idempotent and safe with no connection', () => {
    const client = new RemoteClient();
    assert.deepStrictEqual(client.disconnect(), { ok: true });
    assert.deepStrictEqual(client.disconnect(), { ok: true });
    assert.strictEqual(client.state.phase, 'idle');
});
