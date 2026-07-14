'use strict';

// Unit tests for the remote command bar's ssh-command parser.
// Run: node --test src/features/ssh-command-parse.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseSshCommand } = require('./ssh-command-parse');

test('ssh user@host', () => {
    assert.deepStrictEqual(parseSshCommand('ssh ethan@pop-os'), {
        host: 'pop-os', username: 'ethan', sshPort: null, extraArgs: []
    });
});

test('ssh user@host -p 2222 (port after dest)', () => {
    const c = parseSshCommand('ssh ethan@pop-os -p 2222');
    assert.strictEqual(c.host, 'pop-os');
    assert.strictEqual(c.username, 'ethan');
    assert.strictEqual(c.sshPort, 2222);
});

test('ssh -p 2222 user@host (port before dest) and combined -p2222', () => {
    assert.strictEqual(parseSshCommand('ssh -p 2222 ethan@pop-os').sshPort, 2222);
    assert.strictEqual(parseSshCommand('ssh -p2222 ethan@pop-os').sshPort, 2222);
});

test('ssh host (user comes from ssh config)', () => {
    assert.deepStrictEqual(parseSshCommand('ssh pop-os'), {
        host: 'pop-os', username: '', sshPort: null, extraArgs: []
    });
});

test('bare user@host (no ssh prefix)', () => {
    const c = parseSshCommand('ethan@192.168.1.20');
    assert.strictEqual(c.host, '192.168.1.20');
    assert.strictEqual(c.username, 'ethan');
});

test('bare host only', () => {
    assert.strictEqual(parseSshCommand('pop-os').host, 'pop-os');
});

test('-l user host, and user@host wins over -l', () => {
    assert.strictEqual(parseSshCommand('ssh -l ethan pop-os').username, 'ethan');
    assert.strictEqual(parseSshCommand('ssh -l other ethan@pop-os').username, 'ethan');
});

test('-i and -o pass through as extraArgs', () => {
    const c = parseSshCommand('ssh -i /tmp/key -o IdentitiesOnly=yes ethan@pop-os');
    assert.deepStrictEqual(c.extraArgs, ['-i', '/tmp/key', '-o', 'IdentitiesOnly=yes']);
    assert.strictEqual(c.host, 'pop-os');
});

test('argument-less flags pass through', () => {
    const c = parseSshCommand('ssh -A -4 ethan@pop-os');
    assert.deepStrictEqual(c.extraArgs, ['-A', '-4']);
});

test('ssh:// URI form', () => {
    assert.deepStrictEqual(parseSshCommand('ssh://ethan@pop-os:2222'), {
        host: 'pop-os', username: 'ethan', sshPort: 2222, extraArgs: []
    });
    assert.strictEqual(parseSshCommand('ssh://pop-os').sshPort, null);
});

test('rejects empty input, missing destination, trailing remote command', () => {
    assert.throws(() => parseSshCommand('   '), /Type an ssh command/);
    assert.throws(() => parseSshCommand('ssh -p 22'), /Missing destination/);
    assert.throws(() => parseSshCommand('ssh host uptime'), /Unexpected extra word/);
});

test('rejects bad ports and dangling flags', () => {
    assert.throws(() => parseSshCommand('ssh -p 99999 host'), /Invalid port/);
    assert.throws(() => parseSshCommand('ssh -p abc host'), /Invalid port/);
    assert.throws(() => parseSshCommand('ssh host -i'), /needs a value/);
});

test('rejects @host with empty user', () => {
    assert.throws(() => parseSshCommand('ssh @host'), /Missing username/);
});
