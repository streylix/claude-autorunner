'use strict';

// T512: the streamed draft is INTERNAL and DURABLE.
//   c1 nothing is posted to Discord while he talks — only the final "Heard:"
//   c2 each segment is appended to a draft file on disk and fsynced as it lands
//   c3 the stitched draft is what goes to 999 (no whole-clip re-transcribe), so
//      stop→injection time does not grow with utterance length
//   c4 retention: only drafts already handed to 999 are pruned, after the age
// Run: node --test src/voiceReceive.durable.test.js

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setup, talk, waitFor, sleep } = require('./voiceHarness');

const h = setup();
const { config, calls, receiver, vr } = h;
const TextMirror = require('./textMirror');

// Count fsyncs (voiceReceive calls fs.fsyncSync through the shared module).
let fsyncs = 0;
const realFsync = fs.fsyncSync;
fs.fsyncSync = (fd) => { fsyncs += 1; return realFsync(fd); };

const defaults = { ...config };
const liveFiles = () => { try { return fs.readdirSync(config.draftDir).filter((n) => !n.endsWith('.sent.jsonl')); } catch (_) { return []; } };
const sentFiles = () => { try { return fs.readdirSync(config.draftDir).filter((n) => n.endsWith('.sent.jsonl')); } catch (_) { return []; } };
const lines = (n) => fs.readFileSync(path.join(config.draftDir, n), 'utf8').split('\n').filter(Boolean).map(JSON.parse);

beforeEach(async () => {
  Object.assign(config, defaults);
  h.setWhisperDelay(() => 0);
  await waitFor(() => vr.utterances.size === 0 && !vr.isWriting(), 5000);
  await sleep(150);
  for (const k of Object.keys(calls)) calls[k].length = 0;
  fs.rmSync(config.draftDir, { recursive: true, force: true });
});

test('c1: no draft messages reach Discord — one "Heard:" after the send, nothing else', async () => {
  assert.strictEqual(typeof TextMirror.prototype.draftUpdate, 'undefined', 'Discord draft API still present');
  const sent = [];
  const edits = [];
  const tm = new TextMirror();
  tm.channel = { send: async (m) => { sent.push(m.content); return { edit: async (e) => edits.push(e) }; } };
  config.textMirrorEnabled = true;
  vr.onHeard = (text) => tm.postHeard(text); // exactly how index.js wires it
  config.draftMinSegmentMs = 300;
  config.draftGapMs = 150;
  for (let i = 0; i < 3; i++) { await talk(receiver, 400); await sleep(250); }
  assert.strictEqual(sent.length, 0, `posted to Discord mid-utterance: ${sent}`);
  await waitFor(() => calls.forward.length > 0, 3000);
  await sleep(200);
  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].startsWith('🎙️ **Heard:**'), sent[0]);
  assert.strictEqual(edits.length, 0, 'no message edits');
  vr.onHeard = (text) => calls.heard.push(text);
});

test('c2: the draft file grows during the utterance and every append is fsynced', async () => {
  config.draftMinSegmentMs = 300;
  config.draftGapMs = 150;
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const f0 = fsyncs;
    await talk(receiver, 400);
    await sleep(250);
    const files = liveFiles();
    assert.strictEqual(calls.forward.length, 0);
    assert.strictEqual(files.length, 1, 'one draft file for the open utterance');
    seen.push(lines(files[0]).length);
    assert.ok(fsyncs > f0, `segment ${i + 1} was not fsynced`);
  }
  assert.deepStrictEqual(seen, [1, 2, 3], `segment lines on disk as he talked: ${seen}`);
  assert.ok(path.dirname(path.join(config.draftDir, 'x')) === config.draftDir);
  await waitFor(() => calls.forward.length > 0, 3000);
  await sleep(100);
  const done = sentFiles();
  assert.strictEqual(done.length, 1, 'renamed *.sent.jsonl after the hand-off');
  const recs = lines(done[0]);
  assert.ok(recs.every((r) => r.at), 'every line timestamped');
  assert.deepStrictEqual(recs.filter((r) => r.text).map((r) => r.text).join(' '), calls.forward[0], 'file holds exactly what was sent');
  assert.strictEqual(recs[recs.length - 1].sent, true);
});

// Emulate Whisper at 2x real time (+50ms overhead). A whole-clip pass at the
// stop would then cost ~half the utterance length.
async function stopToInjection(talkMs) {
  await talk(receiver, talkMs);
  const t0 = Date.now();
  vr.setMute('u1', true); // a stop
  await waitFor(() => calls.forward.length > 0, 15000, 5);
  const ms = calls.forwardAt[0] - t0;
  vr.setMute('u1', false);
  return ms;
}

test('c3: stitched draft goes to 999; stop→injection does not scale with length', async () => {
  config.draftMinSegmentMs = 100000; // only the max-length cut: continuous speech
  config.draftMaxSegmentMs = 1500;
  h.setWhisperDelay((ms) => 50 + ms / 2);
  const short = await stopToInjection(600);
  const shortCalls = calls.transcribe.slice();
  for (const k of Object.keys(calls)) calls[k].length = 0;
  await sleep(300);
  const long = await stopToInjection(8000);
  const longText = calls.forward[0];
  const maxSeg = Math.max(...calls.transcribe);
  // eslint-disable-next-line no-console
  console.log(`# stop→injection: short 600ms utterance ${short}ms, long 8000ms utterance ${long}ms (whole-clip pass would add ~4000ms)`);
  assert.strictEqual(shortCalls.length, 1);
  assert.ok(maxSeg <= 1600, `a ${maxSeg}ms Whisper call — the whole clip was re-transcribed`);
  assert.ok((longText.match(/said/g) || []).length >= 5, `long message is the stitched draft: "${longText}"`);
  assert.ok(Math.abs([...longText.matchAll(/said (\d+)ms/g)].reduce((a, m) => a + +m[1], 0) - 8000) <= 100, 'draft covers all 8s');
  assert.ok(long < short + 1000, `stop→injection grew with length: short ${short}ms, long ${long}ms`);
  assert.ok(long < 2000, `long stop→injection ${long}ms — looks like a whole-clip pass`);
});

test('c4: retention — sent drafts pruned after the age; unsent drafts never; nothing before hand-off', async () => {
  fs.mkdirSync(config.draftDir, { recursive: true });
  const old = (Date.now() - (config.draftRetentionHours + 1) * 3600e3) / 1000;
  const mk = (n, t) => { const f = path.join(config.draftDir, n); fs.writeFileSync(f, '{}\n'); if (t) fs.utimesSync(f, t, t); };
  mk('old.sent.jsonl', old);
  mk('old-crash-leftover.jsonl', old);
  mk('recent.sent.jsonl');
  vr._pruneDrafts(true);
  assert.deepStrictEqual(fs.readdirSync(config.draftDir).sort(), ['old-crash-leftover.jsonl', 'recent.sent.jsonl']);

  // Even with retention 0, a draft is not touched before 999 accepts it, and
  // a refused hand-off keeps it unsent (never pruned).
  fs.rmSync(config.draftDir, { recursive: true, force: true });
  config.draftRetentionHours = 0;
  const realForward = vr.linkManager.forward;
  let atHandOff = null;
  vr.linkManager.forward = async (text) => {
    vr._pruneDrafts(true);
    atHandOff = liveFiles().map((n) => lines(n).map((r) => r.text).join(' '));
    calls.forward.push(text);
    return { ok: false, error: 'refused' };
  };
  await talk(receiver, 500);
  await waitFor(() => calls.forward.length > 0, 3000);
  await sleep(100);
  vr._pruneDrafts(true);
  vr.linkManager.forward = realForward;
  assert.deepStrictEqual(atHandOff, [calls.forward[0]], 'draft on disk (unsent) at the moment of hand-off');
  assert.strictEqual(liveFiles().length, 1, 'refused hand-off → draft kept, not pruned');
  assert.strictEqual(sentFiles().length, 0);
});

test.after(() => { fs.fsyncSync = realFsync; setTimeout(() => process.exit(0), 50).unref(); });
