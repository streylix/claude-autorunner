'use strict';

// c4 / c2: the receiver stops delivering mid-capture. The captured audio must
// still be transcribed and sent (once), and the user re-subscribed so the NEXT
// utterance is heard. Before the fix, both scenarios hung the capture forever
// (T510: nine minutes of speech lost on 2026-09-30).
// Run: node --test src/voiceReceive.stall.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const { setup, talk, waitFor, sleep } = require('./voiceHarness');

const h = setup();
const BOUND_MS = 3000; // 600ms test silence + slack; production bound is the configured silence (see OPTIMIZATIONS.md)

test('stream torn down mid-utterance (safety cap / lib teardown) → captured audio sent, user re-subscribed', async () => {
  const { receiver, calls } = h;
  const subs0 = receiver.subscribeCount;
  const fwd0 = calls.forward.length;
  const talking = talk(receiver, 800);          // 800ms of speech…
  await sleep(400);
  const s = receiver.subscriptions.get('u1');
  assert.ok(s, 'capture subscribed');
  s.destroy();                                  // …stream destroyed half-way (what the 180s cap did)
  await talking;
  const t = await waitFor(() => calls.forward.length > fwd0, BOUND_MS);
  assert.ok(t >= 0, `captured audio was never sent within ${BOUND_MS}ms (capture hung)`);
  assert.strictEqual(calls.forward.length, fwd0 + 1, 'exactly one message to 999');
  assert.ok(receiver.subscribeCount > subs0 + 0, 'subscribed');
  // Keep talking: the user must be re-subscribed and heard again.
  const fwd1 = calls.forward.length;
  await talk(receiver, 400);
  const t2 = await waitFor(() => calls.forward.length > fwd1, BOUND_MS);
  assert.ok(t2 >= 0, 'next utterance after the teardown was never heard (not re-subscribed)');
  await sleep(700);
});

test('UDP packets keep arriving but nothing reaches the stream (decrypt stall) → capture ends, user re-subscribed', async () => {
  const { receiver, calls } = h;
  await sleep(300);
  const subs0 = receiver.subscribeCount;
  receiver.deliver = false;                     // packets arrive; the stream gets nothing
  await talk(receiver, 1500);
  receiver.deliver = true;                      // decryption recovers
  const fwd0 = calls.forward.length;
  await talk(receiver, 500);
  const t = await waitFor(() => calls.forward.length > fwd0, BOUND_MS);
  assert.ok(receiver.subscribeCount > subs0 + 1, `never re-subscribed after the stall (subscribes: ${receiver.subscribeCount - subs0})`);
  assert.ok(t >= 0, 'speech after the stall was never transcribed');
  await sleep(700);
});

test.after(() => setTimeout(() => process.exit(0), 50).unref());
