'use strict';

// Unit tests for the manager→bridge outbox helpers: channel-name normalisation
// (both sides must agree, or a repeat post creates a duplicate channel), the
// text-file allowlist, and the result-file round trip the CLI relies on to
// report what really happened.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  sanitizeChannelName, isTextFileName, resultPathFor, isResultFile,
  writeResult, waitForResult, MAX_CHANNEL_NAME,
} = require('./outbox');

test('channel names are normalised to what Discord will actually store', () => {
  assert.equal(sanitizeChannelName('rma-drafts'), 'rma-drafts');
  assert.equal(sanitizeChannelName('RMA Drafts'), 'rma-drafts');
  assert.equal(sanitizeChannelName('  WD  RMA   Letter  '), 'wd-rma-letter');
  assert.equal(sanitizeChannelName('rma_drafts'), 'rma-drafts');
  assert.equal(sanitizeChannelName('#rma-drafts!'), 'rma-drafts');
  assert.equal(sanitizeChannelName('a/b\\c'), 'abc');
});

test('normalisation is idempotent — a repeat post finds the same channel', () => {
  for (const raw of ['RMA Drafts', 'rma drafts', '--RMA--Drafts--', 'rma-drafts']) {
    const once = sanitizeChannelName(raw);
    assert.equal(sanitizeChannelName(once), once, raw);
    assert.equal(once, 'rma-drafts', raw);
  }
});

test('unusable names come back empty so the caller can fall back', () => {
  assert.equal(sanitizeChannelName(''), '');
  assert.equal(sanitizeChannelName('   '), '');
  assert.equal(sanitizeChannelName('!!!'), '');
  assert.equal(sanitizeChannelName('🎉🎉'), '');
  assert.equal(sanitizeChannelName(null), '');
  assert.equal(sanitizeChannelName(undefined), '');
});

test('names are capped at Discord length and never end in a dash', () => {
  const long = sanitizeChannelName('a'.repeat(300));
  assert.equal(long.length, MAX_CHANNEL_NAME);
  const cut = sanitizeChannelName(`${'b'.repeat(99)} tail`);
  assert.ok(cut.length <= MAX_CHANNEL_NAME);
  assert.ok(!cut.endsWith('-'), cut);
});

test('the text-file allowlist takes drafts and refuses binaries', () => {
  for (const ok of ['draft.md', '/tmp/a.txt', 'x.MD', 'data.json', 'rows.csv', 'run.log']) {
    assert.ok(isTextFileName(ok), ok);
  }
  for (const no of ['shot.png', 'clip.mp4', 'archive.zip', 'noext', 'a.exe']) {
    assert.ok(!isTextFileName(no), no);
  }
});

test('result files are named off the descriptor and never look like one', () => {
  assert.equal(resultPathFor('/o/txt-1-ab.json'), '/o/txt-1-ab.result.json');
  assert.ok(isResultFile(resultPathFor('/o/txt-1-ab.json')));
  assert.ok(!isResultFile('/o/txt-1-ab.json'));
});

test('the bridge writes a result the CLI reads once, then consumes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbot-outbox-test-'));
  const desc = path.join(dir, 'txt-1-abcd.json');
  writeResult(desc, { ok: true, channel: 'rma-drafts', fallback: false });

  const got = await waitForResult(desc, 2000, 20);
  assert.deepEqual(got, { ok: true, channel: 'rma-drafts', fallback: false });
  // Consumed, so a later post can't read a stale verdict.
  assert.ok(!fs.existsSync(resultPathFor(desc)));

  const again = await waitForResult(desc, 150, 20);
  assert.equal(again, null, 'no result → null, never a false success');
  fs.rmSync(dir, { recursive: true, force: true });
});
