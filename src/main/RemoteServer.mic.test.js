'use strict';

// Tests for RemoteServer's client-mic stream ownership (REMOTE_MODE.md §10):
//   - first client to send remote-mic-state{active:true} owns the stream;
//   - a second starter is pushed 'remote-mic-denied' and its frames dropped;
//   - only the owner's frames are dispatched to main;
//   - a clean stop / an owner disconnect releases ownership and dispatches a
//     synthetic remote-mic-state{active:false} so the pipeline never hangs.
//
// Run: node --test src/main/RemoteServer.mic.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const RemoteServer = require('./RemoteServer');

function makeServer() {
    const dispatched = [];
    const srv = new RemoteServer({
        appRoot: '/tmp',
        token: 'testtoken',
        deps: {
            log: () => {},
            dispatchSend: (channel, args) => dispatched.push({ channel, args }),
            dispatchInvoke: async () => ({}),
            broadcastAll: () => {},
            getState: () => ({}),
            getScreen: async () => ({}),
            hasPty: () => false
        }
    });
    return { srv, dispatched };
}

function makeWs() {
    return {
        readyState: 1,
        pushed: [],
        send(s) { this.pushed.push(JSON.parse(s)); }
    };
}

const frame = (pcm16 = 'AAAA') => ({ channel: 'remote-mic-frame', args: [{ seq: 0, rate: 16000, pcm16 }] });
const state = (active) => ({ channel: 'remote-mic-state', args: [{ active }] });

test('first-come mic ownership; second starter is denied and its frames dropped', async () => {
    const { srv, dispatched } = makeServer();
    const ws1 = makeWs();
    const ws2 = makeWs();

    await srv.handleSend(ws1, state(true));
    assert.strictEqual(srv.micOwner, ws1);
    assert.deepStrictEqual(dispatched[0], { channel: 'remote-mic-state', args: [{ active: true }] });

    await srv.handleSend(ws2, state(true));
    assert.strictEqual(srv.micOwner, ws1, 'owner unchanged');
    assert.strictEqual(ws2.pushed.length, 1);
    assert.strictEqual(ws2.pushed[0].channel, 'remote-mic-denied');

    await srv.handleSend(ws1, frame('OWNER'));
    await srv.handleSend(ws2, frame('INTRUDER'));
    const frames = dispatched.filter((d) => d.channel === 'remote-mic-frame');
    assert.strictEqual(frames.length, 1, 'only the owner\'s frames dispatch');
    assert.strictEqual(frames[0].args[0].pcm16, 'OWNER');
});

test('only the owner can stop; stop releases ownership for the next client', async () => {
    const { srv, dispatched } = makeServer();
    const ws1 = makeWs();
    const ws2 = makeWs();

    await srv.handleSend(ws1, state(true));
    await srv.handleSend(ws2, state(false)); // non-owner stop: ignored
    assert.strictEqual(srv.micOwner, ws1);

    await srv.handleSend(ws1, state(false));
    assert.strictEqual(srv.micOwner, null);
    assert.deepStrictEqual(dispatched[dispatched.length - 1], { channel: 'remote-mic-state', args: [{ active: false }] });

    await srv.handleSend(ws2, state(true)); // now free for the next client
    assert.strictEqual(srv.micOwner, ws2);
    assert.strictEqual(ws2.pushed.length, 0, 'no denial once the mic is free');
});

test('owner disconnect releases the mic and signals a synthetic detach', async () => {
    const { srv, dispatched } = makeServer();
    const ws1 = makeWs();
    await srv.handleSend(ws1, state(true));

    srv._releaseMic(ws1); // what the ws close handler calls
    assert.strictEqual(srv.micOwner, null);
    const last = dispatched[dispatched.length - 1];
    assert.strictEqual(last.channel, 'remote-mic-state');
    assert.strictEqual(last.args[0].active, false);
    assert.strictEqual(last.args[0].reason, 'client disconnected');

    // A non-owner disconnect must NOT signal anything.
    const before = dispatched.length;
    srv._releaseMic(makeWs());
    assert.strictEqual(dispatched.length, before);
});

test('frames from a client that never claimed the mic are dropped', async () => {
    const { srv, dispatched } = makeServer();
    await srv.handleSend(makeWs(), frame());
    assert.strictEqual(dispatched.length, 0);
});
